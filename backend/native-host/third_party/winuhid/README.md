# WinUHid, vendored

Upstream: https://github.com/cgutman/WinUHid, commit `d6cebbef5c7909168d1f881185be8f607d6aefd4`
(28/05/2025), MIT licence (`LICENSE`), by Cameron Gutman.

A UMDF2 driver that sits above Windows' in-box Virtual HID Framework (VHF) and lets a user-mode
process create HID devices from any report descriptor, then feed their input reports and answer
their output, get-feature and set-feature requests. MoonlightWeb's HID passthrough builds its
Windows driver, "MoonlightWeb Virtual HID", from it (plan P1; study
`docs/design/hid-passthrough-study.md`).

Kept from upstream, with its folder names so its relative includes still resolve:

- `WinUHid Driver/`: the driver (`WinUHid.c`, `WinUHid.h`, `Public.h`, `Trace.h`) and its INF;
- `WinUHid/`: the client library (`WinUHid.cpp`, `WinUHid.h`, `pch.*`).

Left out: the sample devices (`WinUHidDevs`), the unit tests, the WiX installer and its root CA
helper, the Visual Studio solution.

The build project, our INF and the signing script live in `backend/native-host/drivers/vhid/`.
MoonlightWeb's changes to these files are listed below, each one in its own commit.

## MoonlightWeb changes

One fix applies to every build, since it fixes a bug:

- `WinUHid.c`: IOCTL_WINUHID_GET_NEXT_EVENT parks itself in its manual queue under the lock that
  operations are queued under, and `DispatchAsyncOperation` looks for a parked request under it
  too (`FillNextEventLocked`). Upstream parked the request after dropping the lock: an
  operation VHF handed over in between found no parked request and waited for the next
  operation to wake it. A game whose synchronous write was that operation sent none, and froze
  (ACC in `pid!PID_SendReportBl`, bench of 11/10/2026). Driver 0.1.1.0.

Everything else is behind `MOONLIGHTWEB_VHID`, which our build defines, so the files still build
as upstream's, with that fix, without it:

- `Public.h`: the control device is `\\.\MoonlightWebVHid`, never `\\.\WinUHid`, so a WinUHid
  installed by someone else never collides with ours;
- `Trace.h`: a WPP control GUID of our own (8c1f6b0e-3d52-4a77-9e1b-5a2f0c6d7e41), written out
  since tracewpp reads it as text;
- `WinUHid.c`, `WinUHid.h`: IOCTL_WINUHID_SET_REPORT_DESCRIPTOR refuses, with
  STATUS_ACCESS_DENIED, any descriptor the engine's `validate()` refuses
  (`drivers/vhid/DescriptorCheck.cpp`): game devices only, as the host checks already.
- `Public.h`, `WinUHid.c`: IOCTL_MOONLIGHTWEB_VHID_GET_FIXES answers the `MOONLIGHTWEB_VHID_FIX_*`
  flags of the driver (`WinUHid.h`), today `MOONLIGHTWEB_VHID_FIX_EVENT_WAKEUP`, the fix above. A
  driver older than it fails the IOCTL as unknown: no fixes.
- `WinUHid/WinUHid.cpp`, `WinUHid/WinUHid.h` (client library):
  `WinUHidGetHandle`, `WinUHidAdoptDevice` and `WinUHidResumeDevice`, so a device outlives the
  stream's process: the driver keeps it while any handle to it is open, the handle is duplicated
  into the next process, which services its events from then on (`HidParking`).
  `WinUHidIsServicingEvents`, for the log. `WinUHidGetDriverFixes`, asked once per device: with
  a driver older than the fix above, the event thread asks again every 10 ms instead of waiting
  without end, which finds an operation whose wakeup was lost. Such a driver can still be the
  one loaded after an update, until Windows restarts, when a game held a device during it.

The INF is ours (`drivers/vhid/MoonlightWebVHid.inf`): hardware id, DLL, UMDF service and strings
renamed; upstream's ACL kept.
