# The host's own upload against the stream — the bench's probes

Plan « le stream passe avant un gros envoi du PC hôte » (24/10/2026). On the
evening of 24/10, the stream from DualRTX to a Wi-Fi client froze for 2 to
27 s whenever TeraBox uploaded 40-125 Mbit/s from DualRTX itself, although
every packet of the stream already left marked AF41. A ping from DualRTX to
the box, without any stream, rose to 240-746 ms (median 13 ms, ~1 ms on a
cable). The first question is where that queue sits. The second is whether
capping the host's other uploads, below what the path carries, keeps it empty.

No new executable, nothing that listens, no elevation, except `hostup_cap.ps1
-On/-Off/-Show`, which is a system change for a trial with Bruno only.

## Tools

| File | What |
|---|---|
| `hostup_probe.ps1` | timestamped ICMP pings to several targets at once (one runspace each, 200 ms), and the adapter's byte counters once a second, into one folder; `-Mark <phase>` opens a phase |
| `tcp_rtt.py` | a marked "ping" without administrator rights: TCP handshake times to an open port, the classes taking turns (DF, AF41, ...) |
| `hostup_report.py` | one table per phase: each path's median / p95 / max and losses, the host's upload, and the worker logs' freezes |
| `hostup_cap.ps1` | the hand-made cap of trial S0: two ActiveStore QoS policies (all TCP and UDP capped, the MoonlightWeb executable exempt), `-Off`, `-Show`, `-DryRun` |

## Where the queue is (phase M)

```
$d = "<scratchpad>\m1"
.\hostup_probe.ps1 -OutDir $d -Seconds 1200 `
    -Target box=192.168.1.254,repeater=<its wired IP>,um=<UM790Pro>,m3=<the client>
python tcp_rtt.py 192.168.1.254 --port 80 --classes DF,AF41 --out $d\tcp-box.csv --stop $d\stop
.\hostup_probe.ps1 -OutDir $d -Mark a-paused        # each time the upload is paused or resumed
...
New-Item $d\stop                                    # ends both
python hostup_report.py $d --log <worker log>
```

What each path tells:

| Path from the host | crosses | bad while the host uploads means |
|---|---|---|
| a machine on the same switch | the host's NIC and vSwitch, the switch | the queue is in the host itself |
| the repeater's own address | the cable to the repeater | its Ethernet side |
| the box | the repeaters' Wi-Fi link | the repeater's radio toward the box |
| a Wi-Fi client of the repeater | the repeater's radio toward its clients | what the stream feels |
| `tcp_rtt.py` AF41 against DF, to the box | the same link, marked | equal = the queue ignores the mark |

The repeater's address: its MAC is in `freebox-api-rates` (38:07:16:BD:16:37
for the 2nd floor), its IP in the Freebox app or `fbx.py hosts`.

## The cap (trial S0, with Bruno's go only)

```
# an elevated PowerShell, typed by Bruno
.\hostup_cap.ps1 -On -Mbps 50 -Exe E:\Code\moonlight-web\build\MoonlightWeb.exe
.\hostup_cap.ps1 -Off
.\hostup_cap.ps1 -Show      # must end with "none of ours"
```

Windows applies one QoS policy per outbound flow, the most specific: the
executable's own policy (DSCP only) wins for the stream, the catch-all cap
takes everything else. The QoS Packet Scheduler must be bound to the
adapter the stream leaves by (`Get-NetAdapterBinding -ComponentID ms_pacer`;
on DualRTX it is, on `vEthernet (LAN)`). A Hyper-V VM leaves by the physical
adapter and is not capped.
