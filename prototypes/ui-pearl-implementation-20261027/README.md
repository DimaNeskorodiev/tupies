# Pearl UI — implementation evidence

These are unaltered screenshots of the actual implementation, not generated concepts. They use a disposable local engine, fictional tasks, a fake provider and real fixture workspace files. No operational transcripts, account details or provider credentials are shown.

- `01-desktop-chat.jpg`: single-column glass conversation, enlarged portrait, compact composer.
- `02-mobile-chat.jpg`: corrected wrapping artifact card and accessible touch actions at 393×852.
- `03-mobile-options.jpg`: the three default-closed Chat options sections.
- `04-mobile-settings.jpg`: Models, Devices & sync, Help and More settings.
- `05-mobile-welcome.jpg`: full-body Scout in the welcome.
- `06-mobile-dashboard.jpg`: direct entry to four actual fixture teammates.
- `07-desktop-profile.jpg`: primary Open chat action and separate profile resources.
- `08-desktop-bots.jpg`: four distinct companions and direct chat entry.

Desktop screenshots use the existing 1728×876 browser viewport. Responsive checks also covered 320×740; the browser override was reset. Final full source suite: 557/557 tests; 68 syntax-checked modules; full build passed. See `docs/verification.md` for scope and physical-device limitations. This UI iteration did not restart live engines, deploy to the VPS or replace native app binaries.
