# Settings

Settings is a pane on the outline measure for notebook and device controls.

Tokens, shell and shared popup patterns are in [design](../design.md).

## Pane and navigation

The header sticks to the top, so the save status and Undo and Redo stay in reach. It has a mono `Notebook and device` register over a Piazzolla title, the status in faint mono, and Undo and Redo as icon buttons at its right. A hairline appears under it once the page scrolls.

On panes 1096 px and wider, an index of the sections sits left of the measure, as the [Library's browse rail](library.md#browse) does, with mono counts. The current section carries the 2 px gilt bar. A section chosen from the index stays current until you scroll by hand.

Sections head with a rubric numeral, a Piazzolla name and a hairline rule, in this order:

1. Preferences.
2. Notebooks and Backups, neither in the embedded demo or on the phone.
3. Devices.
4. Agent changes.
5. About.

Under 600 px (a split pane or the Fold cover), the header tightens. Controls stack under their descriptions except the switch, the time-zone trigger fills the width, and the Reader display aside is dropped.

## Preferences

Preferences contains Theme, Vim keys, Ask before deleting views, Journal day and Reader display. Each row has its name, a mono scope (This device or Notebook) and one muted sentence on the left, with its control flush right. Rows divide with hairlines.

| Control | Presentation and behaviour |
| --- | --- |
| Theme | Uses the mode tabs. |
| Notebook switches | Hairline track with a muted knob. On, the track fills gilt and the knob slides across in canvas. |
| Ask before deleting views | On by default; applies to Library, task and table views. |
| Journal day | One trigger reading Device in sans and the zone in mono. |
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

## Mac devices

The sharing switch has the tailnet address in mono under it, followed by Pair a phone, disabled until sharing is on. Each paired device shows its last sync and Active. A mono line shows the changes kept for devices that have not caught up. Forget waits for hover where there is hover.

Pair a phone opens a dialog: the QR code on white with the code under it in spaced mono, three numbered steps beside it, and the wait on a hairline. The wait turns to `<phone> is paired and copying the notebook.`

## Devices on the phone

The phone shows the Mac it copies, with its address in mono, then Sync with the last sync and anything waiting, Sync now, and offline books.

A failure reads in plain words in `--danger`, with the service's message in its tooltip. A forgotten phone shows Pair again instead of Sync now. A phone without a Mac shows Use my Mac's notebook and Set up.

## Agent changes

Agent changes shows the newest three, newest first: the summary, then the agent and time in mono and the page as a quiet link that turns gilt on hover. Undo waits for hover where there is hover; Show N earlier unfolds the rest. An undone change reads muted, with Undone in place of the button.

## About

About shows the notebook's path, creation date and id, then the service's version, URL, assets and launch agent, as two mono lists, since they are read rarely and changed never.
