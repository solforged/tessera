# Research desk

The desk follows a question through its perspectives to their sources. It uses three queries, not a spread of selected notes. Tokens, type and shared controls follow [design](../design.md).

## Opening

Open research desk is in Commands and the sidebar's Questions menu. Open in desk in a question's menu selects that question. A saved desk opens with the other saved views.

Open beside opens in place when the window cannot fit two panes. Explicit beside menu entries disable with `Needs a wider window`.

## Linked columns

At a pane width of at least 840 px, three ruled columns share the pane:

| Column | Query and rows |
| --- | --- |
| Questions | Active or recurrent questions, grouped by their top-level program. Each row shows title, state, perspective count, last assessment and revisit date. When the first row names the program itself, it supplies the group title without a duplicate heading. |
| Perspectives | Perspectives on the selected question or any of its branches. Each row shows holder, Gist and Work. |
| Sources | Sources cited in the selected perspective's subtree. Each row shows title, creator, publication date and authored or passage locators. |

Each header describes its query in words. Edit exposes search and the table's field and attribute filter picker. Conditions can be changed or removed; they affect only their column. Choosing another question or perspective updates the next column's linked condition while retaining its other filters.

A selected row has the shared gilt rule and selection fill. Click selects. Open or a double-click opens the original question, perspective dossier or source page. The research desk fills the pane to the right when one exists; otherwise it uses its own pane. ⌘-click opens beside (Ctrl-click off Mac). Sources without a stored publication date do not invent a year; plain references without locators show no location.

## Keyboard

Up and Down move within a column. Right moves to the selected row in the next column, or its first result. Left returns to the previous column. Enter opens the selected row in the pane to the right when one exists; otherwise it uses the desk's pane. ⌘Enter opens beside (Ctrl+Enter off Mac). A column without a selection says what to choose and offers a button back to that column.

## Saving

Save desk asks for a name and saves all three queries as one view with the desk layout. A typed name survives a click outside the form; Escape and Cancel close it. Save changes updates an existing view. Undo save and Redo save, also available through the usual undo chords, reverse the latest save without changing rows. Missing fields are named and can be removed from the view.

Back and Forward restore all three queries, selected rows and the current column. Reload keeps the same pane state. Opening a saved desk restores its question and perspective from the linked conditions without changing the view or adding a save operation.

## Narrow panes

Below 840 px of pane width, including a desktop split, only the current column shows. Selecting a question or perspective advances one step. The Question › Perspective › Sources breadcrumb returns to earlier steps without dropping the selection. Keyboard Left and Right use the same stepped layout. Rows and query labels wrap inside the pane; no horizontal scroll is needed.
