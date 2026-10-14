# Live room UI (`components/live/room`)

One Meet-style room for webinars and 1:1 calls. Presentational: the page
binding owns the engine (`useLiveSession`, `useLocalMedia`, recording) and
renders `<LiveRoom/>` with data + callbacks. Every prop is documented on
`LiveRoomProps` in `components/live/room/types.ts`; `index.ts` shows the wiring.

## Layout
- `fixed inset-0 z-[60]` dark surface over the dashboard chrome (URLs unchanged).
- Top bar: title, LIVE, REC (everyone), elapsed, audience count (hosts).
- Stage + filmstrip (right column when wide, row underneath when narrow).
- Side panel (webinars): 360px column on desktop, bottom sheet on phones that
  stops above the control bar.
- Control bar pinned at the bottom; menus are popovers anchored to their
  button (one open at a time); toasts sit above the bar, never on it.
- Notices and toasts stack at the top of the stage. On touch screens a tile's
  Pin / Full screen buttons are always shown, so the stack starts below the
  main tile's action row; small tiles label "Pin for everyone" as "Everyone"
  there (no tooltip on touch).

## Main stage (`stage-model.ts`, tested in `lib/live-stage-model.test.ts`)
1. The viewer's local pin.
2. A presentation (screen or slides): the primary host's, else the most recent.
3. Webinar: the primary host's camera.
4. Call with two people: the other person, self as PiP.
5. Call with three or more: equal grid.

Presentations are `object-contain` on black; cameras `object-cover`. A
presenter never sees their own capture: "You're presenting" (screen) or the
presenter view (slides). When another presentation holds the stage, their own
is a filmstrip card ("You're presenting", or slides n/N with previous / next /
Stop) and a toast says whose is up. The shared view (`computeStage` with no local
pin) is what the recorder composes: the room reports it through `onSharedLayout`.

## Presenting (`usePresentation`)
One state: none | screen | deck. Its `stream` goes into the session's
`screenStream` (no protocol change). Screen share uses capped constraints and
`contentHint = "detail"`; errors are spelled out (macOS screen-recording
permission), cancel is silent, and it is hidden where `getDisplayMedia` is
missing. Slides: pdf.js (legacy build, worker chunk) renders a PDF from disk or
the event's deck URL to a 1920×1080 canvas, captured as a stream and repainted
at 2 fps so late joiners get frames. Keys: ←/→, PgUp/PgDn, Space, Home/End,
Esc stops.

## Devices
Green room and the in-call "Audio & video" dialog share `DeviceControls`: mic
picker + meter + 3-second test, camera picker, speaker picker + test sound.
Webinar viewers get the speaker part only. Levels and the speaking ring come
from one shared analyser (`audio-levels.ts`, 10 Hz, leaf components only).
Remote audio plays from one hidden `<audio>` per peer (`AudioSinks`), routed to
the chosen speaker, with "Enable sound" when autoplay is blocked.

Shortcuts: Ctrl/Cmd+D mic, Ctrl/Cmd+E camera.

## Harness
`/dev/live` (localhost only) renders every state on a fake session:
`/dev/live?state=<state>&w=<variant>`; the index lists them. `npm run
room-screens` screenshots all of them at 1440×900, 390×844 and 320×700 (the
phones as touch screens) and checks the layout (bar on screen, nothing over
it, notices off the main tile's buttons, presentations not cropped).
