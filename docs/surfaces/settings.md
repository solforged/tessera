# Settings

Settings is a pane on the outline measure for notebook and device controls.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Pane and navigation

The header sticks to the top, so the save status and Undo and Redo stay in reach. It has a mono `Notebook and device` register over a Piazzolla title, the status in faint mono, and Undo and Redo as icon buttons at its right. A hairline appears under it once the page scrolls.

On panes 1096 px and wider, an index of the sections sits left of the measure, as the [Library's browse rail](library.md#browse) does, with mono counts. The current section carries the 2 px gilt bar. Once the page can scroll no further, the last section is current. A section chosen from the index stays current until you scroll by hand.

Sections head with a rubric numeral, a Piazzolla name and a hairline rule, in this order:

1. Preferences.
2. Notebooks and Backups on the Mac; only Backups in the browser build; neither on the phone.
3. Devices.
4. Agent changes.
5. About.

Under 600 px (a split pane or the Fold cover), the header tightens. Controls stack under their descriptions except the switch, the time-zone trigger fills the width, and the Reader display aside is dropped.

## Preferences

Preferences contains Theme, Vim keys, Ask before deleting views, Journal day and Reader display. Each row has its name, a mono scope (This device or Notebook) and one muted sentence on the left, with its control flush right. Rows divide with hairlines.

| Control | Presentation and behavior |
| --- | --- |
| Theme | Uses the mode tabs. |
| Notebook switches | Hairline track with a muted knob. On, the track fills gilt and the knob slides across in canvas. |
| Ask before deleting views | On by default; applies to Library, task and table views. |
| Journal day | One trigger reading Device in sans and the zone in mono. The zone picker always includes UTC alongside regional zones. |
| Reader display | Only says that typeface, size, measure and layout are set in the reader, beside the text. |

## Notebooks

The list contains each notebook the Mac knows. Its name is Default notebook for the platform one, else the folder name. The one in use has a mono Open scope, and each notebook's folder is in faint mono under its name.

Others offer Open and Forget. Forget waits for hover and only drops the list entry. A notebook whose folder is gone reads Folder missing.

Another notebook takes a full path in a mono field, with Open for an existing notebook and New for an empty one in a new or empty folder. Switching covers the window with `Opening <name>…` in mono until it reloads on the chosen notebook. The palette lists the same notebooks as `Switch to notebook: <name>`.

While a notebook other than the default is open, the sidebar's Settings row names it at its right in `--warning` mono, its folder in the tooltip.

## Backups

Backups shows Back up now, the latest backup's time under the label, and the backup count with total storage in mono. Earlier backups fold into a disclosure of mono date, object count, path and size rows, each with Delete.

Delete opens an inline Delete? confirmation with Cancel and Confirm; deleting a backup cannot be undone. When more than ten exist, Delete older backups offers an inline confirmation stating the count to delete and space to free, then keeps the latest ten. The newest backup is always kept as a restore point.

Backup actions disable together while working, refresh the list when complete, and report failures in Settings' error slot.

## Backups in the browser

The browser build keeps one notebook in the browser's private storage, so its Backups section moves files in and out instead of listing backups:

| Row | Contents |
| --- | --- |
| Notebook file | Download saves `tessera-YYYY-MM-DD.sqlite`, one file with every page, card and book. A mono line gives the last download on this device, or Not downloaded yet. |
| Restore a backup | Restore… picks a file, then asks `Replace this notebook with <file name>?` inline. |
| Before the last upgrade | Only while a copy exists: schema, date and size in mono, with Download and Restore…. |
| Storage | Only where the browser reports usage: whether the browser keeps the notebook, with Keep it when it may clear it, and usage of quota in mono. A refused request reads `The browser declined. Download backups to keep a copy.` |
| Start over | Start over… asks `Erase this notebook? Download a backup first to keep it.` inline, then returns to the first-run choice. |

Restore and Start over cover the window while they work, then reload. A file that cannot be restored says why (not a Tessera backup, from a newer version, damaged, or with its books outside it) and leaves the notebook as it was.

## Mac devices

A Mac serving without sync says so under the heading: `Sync is off`, and that no phone can pair with it. Otherwise the Mac's own version line (`hyperion · 0.3.0 · schema 35`) and tailnet address head the section. The sharing switch follows, then Pair a phone, disabled until sharing is on. A mono line shows the changes kept for devices that have not caught up.

Pair a phone opens a dialog: the QR code on white with the code under it in spaced mono, three numbered steps beside it, and the wait on a hairline. The wait turns to `<phone> is paired and copying the notebook.`

Each paired device is a disclosure: its name, and its state at the right in `--danger` when it needs the person. Opened, it shows both sides' versions in mono, then the fix first: a version mismatch says which side is behind, in a block with a 2 px rubric rule at its left, with the update route. Last seen, refused since with the attempt count, and last attempt follow as a mono list, then Recent attempts as a small ledger of time, result and count, and Forget. The rail's summary opens Settings with its device expanded.

## Devices on the phone

The phone shows the Mac it copies as the same disclosure: this device's and the Mac's versions, the Mac's address in mono, the fix for the current state, then last synced, failing or refused since, changes waiting and Recent attempts. Sync now sits with the facts; a forgotten phone shows Pair again instead. A phone without a Mac shows Use my Mac's notebook and Set up. Offline books follow.

## Needs review

Both sides list what sync kept for the person, under a Needs review disclosure with mono counts (`1 kept · 2 rejected`). Each item reads its device and age in mono, the page title in Piazzolla and its words as a quotation. A kept copy offers Open the page. A rejected change also gives the hub's reason, with Open the page while the page exists, Copy the text back and Dismiss. A page that is gone reads `Page no longer available`, and Copy the text back then adds the words to today's journal.

## Agent changes

Agent changes shows the newest three, newest first: the summary, then the agent and time in mono and the page as a quiet link that turns gilt on hover. Undo waits for hover where there is hover; Show N earlier unfolds the rest. An undone change reads muted, with Undone in place of the button.

## About

About shows the notebook's path, creation date and id, then the service's version, URL, assets and launch agent, as two mono lists, since they are read rarely and changed never.
