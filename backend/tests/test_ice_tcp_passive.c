/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * Passive ICE-TCP, our patch on libjuice (third_party/patches/
 * libjuice-ice-tcp-passive.patch, docs/design/ice-tcp-passive.md): two agents
 * connect over TCP alone, the listener's gate closes everything that is not an
 * authenticated Binding request, and the listener is gone once the checks are
 * over. Plain C against libjuice itself, so a runner of its own. Everything
 * binds 127.0.0.1: no firewall prompt.
 */
#include "juice/juice.h"

#include "socket.h"
#include "stun.h"
#include "thread.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
static void sleep_ms(int ms) { Sleep(ms); }
#else
#include <sys/time.h>
#include <unistd.h>
static void sleep_ms(int ms) { usleep(ms * 1000); }
#endif

static int failures = 0;
#define CHECK(cond)                                                                                \
	do {                                                                                           \
		if (cond) {                                                                                \
			printf("  ok   %s\n", #cond);                                                          \
		} else {                                                                                   \
			printf("  FAIL %s (line %d)\n", #cond, __LINE__);                                      \
			++failures;                                                                            \
		}                                                                                          \
	} while (0)

// ── Raw TCP client ──────────────────────────────────────────────────────────

static socket_t dial(int port) {
	socket_t sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	struct sockaddr_in sin;
	memset(&sin, 0, sizeof(sin));
	sin.sin_family = AF_INET;
	sin.sin_port = htons((uint16_t)port);
	sin.sin_addr.s_addr = htonl(0x7F000001);
	if (connect(sock, (struct sockaddr *)&sin, sizeof(sin)) != 0) {
		closesocket(sock);
		return INVALID_SOCKET;
	}
	return sock;
}

static void set_timeout(socket_t sock, int ms) {
#ifdef _WIN32
	DWORD tv = (DWORD)ms;
#else
	struct timeval tv = {ms / 1000, (ms % 1000) * 1000};
#endif
	setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof(tv));
}

// True when the other end closed (or reset) within `ms`; false when it stayed silent.
static bool closed_within(socket_t sock, int ms) {
	set_timeout(sock, ms);
	char c;
	int len = recv(sock, &c, 1, 0);
	if (len == 0)
		return true;
	if (len > 0)
		return false; // it talked: not closed
#ifdef _WIN32
	return WSAGetLastError() != WSAETIMEDOUT;
#else
	return errno != EAGAIN && errno != EWOULDBLOCK;
#endif
}

static void send_frame(socket_t sock, const char *data, uint16_t announced, size_t len) {
	uint16_t header = htons(announced);
	send(sock, (const char *)&header, 2, 0);
	if (len)
		send(sock, data, (int)len, 0);
}

static int binding_request(char *buf, size_t size, const char *username, const char *password) {
	stun_message_t msg;
	memset(&msg, 0, sizeof(msg));
	msg.msg_class = STUN_CLASS_REQUEST;
	msg.msg_method = STUN_METHOD_BINDING;
	for (int i = 0; i < STUN_TRANSACTION_ID_SIZE; ++i)
		msg.transaction_id[i] = (uint8_t)rand();
	snprintf(msg.credentials.username, STUN_MAX_USERNAME_LEN, "%s", username);
	msg.priority = 1845501695;
	msg.ice_controlling = 0x0123456789ABCDEFull;
	return stun_write(buf, size, &msg, password);
}

// ── Agents ──────────────────────────────────────────────────────────────────

typedef struct side {
	juice_agent_t *agent;
	struct side *peer; // passive candidates go there, if set
	atomic(int) passive_port;
	atomic(int) received;
	char data[64];
} side_t;

static void on_candidate(juice_agent_t *agent, const char *sdp, void *user_ptr) {
	(void)agent;
	side_t *side = user_ptr;
	if (!strstr(sdp, "tcptype passive"))
		return;
	char addr[64];
	int port = 0;
	if (sscanf(sdp, "a=candidate:%*s %*d %*s %*u %63s %d", addr, &port) == 2)
		atomic_store(&side->passive_port, port);
	if (side->peer)
		juice_add_remote_candidate(side->peer->agent, sdp);
}

static void on_recv(juice_agent_t *agent, const char *data, size_t size, void *user_ptr) {
	(void)agent;
	side_t *side = user_ptr;
	size_t n = size < sizeof(side->data) - 1 ? size : sizeof(side->data) - 1;
	memcpy(side->data, data, n);
	side->data[n] = '\0';
	atomic_store(&side->received, 1);
}

static void make(side_t *side, juice_ice_tcp_mode_t mode) {
	juice_config_t config;
	memset(&config, 0, sizeof(config));
	config.concurrency_mode = JUICE_CONCURRENCY_MODE_POLL;
	config.bind_address = "127.0.0.1";
	config.cb_candidate = on_candidate;
	config.cb_recv = on_recv;
	config.user_ptr = side;
	side->agent = juice_create(&config);
	juice_set_ice_tcp_mode(side->agent, mode);
}

static bool wait_state(juice_agent_t *agent, juice_state_t state, int ms) {
	for (int t = 0; t < ms; t += 50) {
		if (juice_get_state(agent) == state)
			return true;
		sleep_ms(50);
	}
	return juice_get_state(agent) == state;
}

static void read_attr(const char *sdp, const char *key, char *out, size_t size) {
	const char *p = strstr(sdp, key);
	out[0] = '\0';
	if (!p)
		return;
	p += strlen(key);
	size_t n = strcspn(p, "\r\n");
	if (n >= size)
		n = size - 1;
	memcpy(out, p, n);
	out[n] = '\0';
}

// ── Tests ───────────────────────────────────────────────────────────────────

static void test_connect_over_tcp_only(void) {
	printf("Two agents connect over passive TCP alone\n");
	side_t a = {0}, b = {0};
	make(&a, JUICE_ICE_TCP_MODE_ACTIVE_PASSIVE); // the host
	make(&b, JUICE_ICE_TCP_MODE_ACTIVE);         // dials, like a browser
	a.peer = &b; // only a's passive candidates travel; nothing of b's does

	char sdp[JUICE_MAX_SDP_STRING_LEN];
	juice_get_local_description(a.agent, sdp, sizeof(sdp));
	juice_set_remote_description(b.agent, sdp);
	juice_get_local_description(b.agent, sdp, sizeof(sdp));
	juice_set_remote_description(a.agent, sdp);

	juice_gather_candidates(a.agent);
	juice_gather_candidates(b.agent);

	CHECK(wait_state(a.agent, JUICE_STATE_COMPLETED, 10000));
	CHECK(wait_state(b.agent, JUICE_STATE_COMPLETED, 2000));
	CHECK(a.passive_port > 0);

	char local[JUICE_MAX_CANDIDATE_SDP_STRING_LEN], remote[JUICE_MAX_CANDIDATE_SDP_STRING_LEN];
	if (juice_get_selected_candidates(a.agent, local, sizeof(local), remote, sizeof(remote)) == 0) {
		printf("  host selected: %s -> %s\n", local, remote);
		CHECK(strstr(remote, "TCP") != NULL);
	} else {
		CHECK(!"selected candidates");
	}

	CHECK(juice_send(b.agent, "from the browser", 16) == 0);
	CHECK(juice_send(a.agent, "from the host", 13) == 0);
	for (int t = 0; t < 2000 && (!a.received || !b.received); t += 50)
		sleep_ms(50);
	CHECK(a.received && strcmp(a.data, "from the browser") == 0);
	CHECK(b.received && strcmp(b.data, "from the host") == 0);

	// Connected: the listener is gone, its port takes nobody.
	socket_t late = dial(a.passive_port);
	CHECK(late == INVALID_SOCKET);
	if (late != INVALID_SOCKET)
		closesocket(late);

	juice_destroy(a.agent);
	juice_destroy(b.agent);
}

static void test_gate(void) {
	printf("The gate closes what is not an authenticated Binding request\n");
	side_t h = {0};
	const char *peer_pwd = "pw01234567890123456789";
	char sdp[JUICE_MAX_SDP_STRING_LEN];
	snprintf(sdp, sizeof(sdp), "a=ice-ufrag:peer\r\na=ice-pwd:%s\r\n", peer_pwd);
	// The UDP socket takes an ephemeral port, whose TCP side another socket of this machine
	// may hold: then there is no listener and no passive candidate, as designed. Another agent.
	for (int attempt = 0; attempt < 5 && !h.passive_port; ++attempt) {
		if (h.agent)
			juice_destroy(h.agent);
		memset(&h, 0, sizeof(h));
		make(&h, JUICE_ICE_TCP_MODE_ACTIVE_PASSIVE);
		juice_set_remote_description(h.agent, sdp);
		juice_gather_candidates(h.agent);
		for (int t = 0; t < 1000 && !h.passive_port; t += 50)
			sleep_ms(50);
	}
	CHECK(h.passive_port > 0);

	char local_sdp[JUICE_MAX_SDP_STRING_LEN], ufrag[64], pwd[64];
	juice_get_local_description(h.agent, local_sdp, sizeof(local_sdp));
	read_attr(local_sdp, "a=ice-ufrag:", ufrag, sizeof(ufrag));
	read_attr(local_sdp, "a=ice-pwd:", pwd, sizeof(pwd));
	char good_user[160], bad_user[160];
	snprintf(good_user, sizeof(good_user), "%s:peer", ufrag);
	snprintf(bad_user, sizeof(bad_user), "zz%s:peer", ufrag);
	char buf[512];

	// Silent: kept a little, then closed by the first-frame deadline (2 s).
	socket_t idle = dial(h.passive_port);
	CHECK(idle != INVALID_SOCKET);
	CHECK(!closed_within(idle, 1000));
	CHECK(closed_within(idle, 2500));
	closesocket(idle);

	// Announced length out of bounds, either way.
	socket_t big = dial(h.passive_port);
	send_frame(big, NULL, 5000, 0);
	CHECK(closed_within(big, 1000));
	closesocket(big);
	socket_t tiny = dial(h.passive_port);
	send_frame(tiny, "0123456789", 10, 10);
	CHECK(closed_within(tiny, 1000));
	closesocket(tiny);

	// Not STUN.
	memset(buf, 'A', 100);
	socket_t junk = dial(h.passive_port);
	send_frame(junk, buf, 100, 100);
	CHECK(closed_within(junk, 1000));
	closesocket(junk);

	// STUN, but the wrong password, then the wrong ufrag.
	int len = binding_request(buf, sizeof(buf), good_user, "not-the-password-at-all");
	socket_t wrong_pwd = dial(h.passive_port);
	send_frame(wrong_pwd, buf, (uint16_t)len, (size_t)len);
	CHECK(closed_within(wrong_pwd, 1000));
	closesocket(wrong_pwd);
	len = binding_request(buf, sizeof(buf), bad_user, pwd);
	socket_t wrong_ufrag = dial(h.passive_port);
	send_frame(wrong_ufrag, buf, (uint16_t)len, (size_t)len);
	CHECK(closed_within(wrong_ufrag, 1000));
	closesocket(wrong_ufrag);

	// Four may wait; a fifth is closed at once, and takes no one's place.
	socket_t waiting[4];
	for (int i = 0; i < 4; ++i)
		waiting[i] = dial(h.passive_port);
	sleep_ms(200);
	socket_t fifth = dial(h.passive_port);
	CHECK(fifth == INVALID_SOCKET || closed_within(fifth, 500));
	if (fifth != INVALID_SOCKET)
		closesocket(fifth);
	bool all_open = true;
	for (int i = 0; i < 4; ++i)
		all_open = all_open && !closed_within(waiting[i], 100);
	CHECK(all_open);
	for (int i = 0; i < 4; ++i)
		closesocket(waiting[i]);
	sleep_ms(300);

	// The real thing: admitted, and answered on the same connection.
	len = binding_request(buf, sizeof(buf), good_user, pwd);
	socket_t good = dial(h.passive_port);
	send_frame(good, buf, (uint16_t)len, (size_t)len);
	set_timeout(good, 2000);
	uint16_t header = 0;
	int got = recv(good, (char *)&header, 2, MSG_WAITALL);
	CHECK(got == 2);
	int resp_len = ntohs(header);
	got = resp_len > 0 && resp_len <= (int)sizeof(buf) ? recv(good, buf, resp_len, MSG_WAITALL) : -1;
	CHECK(got == resp_len);
	stun_message_t resp;
	memset(&resp, 0, sizeof(resp));
	CHECK(got > 0 && stun_read(buf, (size_t)got, &resp) >= 0 &&
	      resp.msg_class == STUN_CLASS_RESP_SUCCESS && resp.msg_method == STUN_METHOD_BINDING);

	// Admitted: the listener is closed.
	sleep_ms(200);
	socket_t after = dial(h.passive_port);
	CHECK(after == INVALID_SOCKET);
	if (after != INVALID_SOCKET)
		closesocket(after);
	closesocket(good);

	juice_destroy(h.agent);
}

static void test_active_only_does_not_listen(void) {
	printf("ACTIVE alone listens on nothing and offers no passive candidate\n");
	side_t s = {0};
	make(&s, JUICE_ICE_TCP_MODE_ACTIVE);
	juice_set_remote_description(s.agent, "a=ice-ufrag:peer\r\na=ice-pwd:pw01234567890123456789\r\n");
	juice_gather_candidates(s.agent);
	sleep_ms(500);
	CHECK(s.passive_port == 0);
	juice_destroy(s.agent);
}

int main(void) {
#ifdef _WIN32
	WSADATA wsa;
	WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
	juice_set_log_level(getenv("JUICE_DEBUG") ? JUICE_LOG_LEVEL_DEBUG : JUICE_LOG_LEVEL_WARN);
	test_connect_over_tcp_only();
	test_gate();
	test_active_only_does_not_listen();
	printf(failures ? "\n%d FAILURE(S)\n" : "\nall passed\n", failures);
	return failures ? 1 : 0;
}
