# Research desk

The desk follows a question through its positions to their sources. It uses three queries, not a spread of selected notes. Tokens, type and shared controls follow [design](../design.md).

## Opening

Open research desk is in Commands and the sidebar's Questions menu. Open in desk in a question's menu selects that question. A saved desk opens with the other saved views.

## Linked columns

At a pane width of at least 840 px, three ruled columns share the pane:

| Column | Query and rows |
| --- | --- |
| Questions | Active or recurrent questions, grouped by their top-level program. Each row shows title, state, reading count, last assessment and revisit date. When the first row names the program itself, it supplies the group title without a duplicate heading. |
| Positions | Positions about the selected question or any of its branches. Each row shows holder, Gist and Work. |
| Sources | Sources cited in the selected position's subtree. Each row shows title, creator, publication date and authored or passage locators. |

Each header describes its query in words. Edit exposes search and the table's field and attribute filter picker. Conditions can be changed or removed; they affect only their column. Choosing another question or position updates the next column's linked condition while retaining its other filters.

A selected row has the shared gilt rule and selection fill. Click selects; Open or a double-click opens the original question, position dossier or source page. Shift opens beside. Sources without a stored publication date do not invent a year; plain references without locators show no location.

## Keyboard

Up and Down move within a column. Right moves to the selected row in the next column, or its first result. Left returns to the previous column. Enter opens the selected row in the main pane; Shift-Enter opens beside. A column without a selection says what to choose and offers a button back to that column.

## Saving

Save desk asks for a name and saves all three queries as one view with the desk layout. Save changes updates an existing view. Undo save and Redo save, also available through the usual undo chords, reverse the latest save without changing rows. Missing fields are named and can be removed from the view.

Back and Forward restore all three queries, selected rows and the current column. Reload keeps the same pane state. Opening a saved desk restores its question and position from the linked conditions without changing the view or adding a save operation.

## Narrow panes

Below 840 px of pane width, including a desktop split, only the current column shows. Selecting a question or position advances one step. The Question › Position › Sources breadcrumb returns to earlier steps without dropping the selection. Keyboard Left and Right use the same stepped layout. Rows and query labels wrap inside the pane; no horizontal scroll is needed.
