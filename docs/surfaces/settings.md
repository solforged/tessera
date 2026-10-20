# Settings

Settings is a pane on the outline measure for workshop and device controls.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Pane and navigation

The header sticks to the top, so the save status and Undo and Redo stay in reach. It has a Piazzolla title, the status in faint mono, and Undo and Redo as icon buttons at its right. A hairline appears under it once the page scrolls.

When the left margin can hold it, the section index sticks outside the centered page measure, with mono counts and a 2 px gilt bar on the current section. Narrower panes use the same index as a horizontally scrolling row of section chips under the title. Both forms scroll to sections and follow the current section. Once the page can scroll no further, the last section is current. A section chosen from the index stays current until you scroll by hand.

Sections use the same mono numbered heads as field definitions, in this order:

1. Preferences.
2. Workshops and Backups on the Mac; only Backups in the browser build; neither on the phone.
3. Devices.
4. Agent.
5. Agent changes.
6. About.

Under 600 px (a split pane or the Fold cover), the header tightens. Controls stack under their descriptions except the switch, the time-zone trigger fills the width, and the Reader display aside is dropped. Paths wrap after slashes, not inside folder names.

## Preferences

Preferences contains Theme, Vim keys, Ask before deleting views, Journal day and Reader display. Each row has its name, a mono scope (This device or Workshop) and one muted sentence on the left, with its control flush right. Rows divide with hairlines.

| Control | Presentation and behavior |
| --- | --- |
| Theme | Uses the mode tabs. |
| Workshop switches | Hairline track with a muted knob. On, the track fills gilt and the knob slides across in canvas. |
| Ask before deleting views | On by default; applies to Library, task and table views. |
| Journal day | A bordered trigger shows the city and current UTC offset, with Device when it follows the device zone. Its picker opens below the trigger, lists canonical cities and offsets with faint searchable IANA ids, and always includes UTC. |
| Reader display | Only says that typeface, size, measure and layout are set in the reader, beside the text. |

## Workshops

The list contains every registered workshop and every workshop folder found inside `~/.local/share/tessera/workshops`, or its XDG data override. Names use the folder name with its first letter capitalized; the default is Main. The one in use has a mono Open scope. A place line appears only for workshops outside that folder or sharing a name; shared names show the full path.

Other workshops offer Open and, except for the default, Forget. Forget drops the registry entry, not the folder. A workshop still in the workshops folder appears again when the list loads. A listed workshop whose folder is gone reads Folder missing.

Open or create accepts a name such as `reading`, an absolute path, or a home-relative path such as `~/Documents/reading`. Names resolve inside the workshops folder. Open uses an existing workshop; New starts an empty one in a new or empty folder. Switching covers the window with `Opening <name>…` in mono until it reloads. Commands lists available workshops as `Switch to workshop: <name>`. The sidebar switcher opens the same workshops.

## Backups

One intro sentence explains daily and pre-update backups, unchanged-backup skipping and retention. The Database and files row shows the last backup time, count and store size in mono, with Back up now at the right. If nothing changed, its status says so. Earlier backups fold into a disclosure with date, file count, size and Delete for each entry.

Delete opens an inline Delete? confirmation with Cancel and Confirm. The newest backup has no Delete control. Other workshops is a second disclosure, showing each other workshop ID's backup count, newest time and store size, including workshops no longer in the list. Its Delete action asks Delete all? and removes that workshop's backup store, not its live folder. Deletion cannot be undone. Retention runs automatically; there is no Keep the latest 10 control.

Backup actions disable together while working, refresh the list when complete, and report failures in Settings' error slot.

Backup and agent-change timestamps use local ISO dates with 24-hour time, such as `2026-10-20 06:51`.

## Backups in the browser

The browser build keeps one workshop in the browser's private storage, so its Backups section moves files in and out instead of listing backups:

| Row | Contents |
| --- | --- |
| Workshop file | Download saves `tessera-YYYY-MM-DD.sqlite`, one file with every page, card and book. A mono line gives the last download on this device, or Not downloaded yet. |
| Restore a backup | Restore… picks a file, then asks `Replace this workshop with <file name>?` inline. |
| Before the last upgrade | Only while a copy exists: schema, date and size in mono, with Download and Restore…. |
| Storage | Only where the browser reports usage: whether the browser keeps the workshop, with Keep it when it may clear it, and usage of quota in mono. A refused request reads `The browser declined. Download backups to keep a copy.` |
| Start over | Start over… asks `Erase this workshop? Download a backup first to keep it.` inline, then returns to the first-run choice. |

Restore and Start over cover the window while they work, then reload. A file that cannot be restored says why (not a Tessera backup, from a newer version, damaged, or with its books outside it) and leaves the workshop as it was.

## Mac devices

A Mac serving without sync says so under the heading: `Sync is off`, and that no phone can pair with it. Otherwise the Mac's own version line (`hyperion · 0.3.0 · schema 35`) and tailnet address head the section. The sharing switch follows, then Pair a phone. Pairing turns Sharing on first when needed, using the same action as the switch. If that is unavailable or fails, `Turn on Sharing first` appears under the button. A mono line shows the changes kept for devices that have not caught up.

Pair a phone opens a dialog: the QR code on white with the code under it in spaced mono, three numbered steps beside it, and the wait on a hairline. The wait turns to `<phone> is paired and copying the workshop.`

Each paired device is a disclosure: its name, and its state at the right in `--danger` when it needs the person. Opened, it shows both sides' versions in mono, then the fix first: a version mismatch says which side is behind, in a block with a 2 px rubric rule at its left, with the update route. Last seen, refused since with the attempt count, and last attempt follow as a mono list, then Recent attempts as a small ledger of time, result and count, and Forget. The rail's summary opens Settings with its device expanded.

## Devices on the phone

The phone shows the Mac it copies as the same disclosure: this device's and the Mac's versions, the Mac's address in mono, the fix for the current state, then last synced, failing or refused since, changes waiting and Recent attempts. Sync now sits with the facts; a forgotten phone shows Pair again instead. A phone without a Mac shows Use my Mac's workshop and Set up. Offline books follow.

## Needs review

Both sides list what sync kept for the person, under a Needs review disclosure with mono counts (`1 kept · 2 rejected`). Each item reads its device and age in mono, the page title in Piazzolla and its words as a quotation. A kept copy offers Open the atom. A rejected change also gives the hub's reason, with Open the atom while the page exists, Copy the text back and Dismiss. A page that is gone reads `Atom no longer available`, and Copy the text back then adds the words to today's journal.

## Agent

Models edit in place. Speaks uses the shared menu, missing Name, Address and Model values show inline errors, and the form saves with Save model. An invalid address also shows its reason inline. Keys remain optional so local servers work without one.

## Agent changes

Agent changes shows the newest three, newest first: the summary, then the agent and time in mono and the page as a quiet link that turns gilt on hover. Undo waits for hover where there is hover; Show N earlier unfolds the rest. An undone change reads muted, with Undone in place of the button.

## About

About shows the workshop's path, creation date and id, then the service's version, URL, assets and launch agent, as two mono lists, since they are read rarely and changed never.

An absent launch agent reads `Not installed`, with the faint explanation `Opening Tessera.app installs it.` No command-line setup is needed.
