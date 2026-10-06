import { ulid } from 'ulid';
import type { Batch, Operation, TaskState } from '../api/types';

export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** One atomic batch: a failed seed cannot leave a half-finished tour. */
export function seedBatch(fieldsPage: string, today = localToday()): Batch {
  const operations: Operation[] = [];
  const page = (title: string) => {
    const id = ulid(); operations.push({ op: 'create_page', id, title }); return id;
  };
  const lastChild = new Map<string, string>();
  const insert = (parent: string, text: string, heading: 1 | 2 | 3 | null = null) => {
    const id = ulid();
    operations.push({ op: 'insert', id, parent_id: parent, after: lastChild.get(parent) ?? null, text, heading });
    lastChild.set(parent, id); return id;
  };
  const link = (id: string, title: string) => `[[${id}|${title}]]`;
  const welcome = page('Welcome to Tessera');
  const ideas = page('Small ideas');
  const learning = page('Learning by doing');
  const ideaType = page('Demo idea');
  const journal = ulid(); operations.push({ op: 'create_journal', id: journal, date: today });

  insert(welcome, 'A notebook to think in', 1);
  insert(welcome, 'Welcome! This is the real Tessera editor and notebook engine, running entirely in your browser. No account, server notebook or cloud sync is involved.');
  insert(welcome, 'Your changes stay in this browser on this device. Clearing site data removes them. Keep one Tessera demo tab open at a time; Reset demo restores this tour.');
  const outline = insert(welcome, 'Make room for a thought', 2);
  insert(outline, 'Click a block to edit it. Enter makes another block; Tab nests it and Shift+Tab brings it back out.');
  insert(outline, 'Try undo and redo, fold a branch, or open a linked page beside this one with Shift+click.');
  insert(welcome, `Follow ${link(ideas, 'Small ideas')} for an outline with typed fields and a saved table, or ${link(learning, 'Learning by doing')} for a few flashcards.`);
  insert(welcome, 'Today opens your daily journal. Agenda collects tasks and their dates. Review lets you study cards. Find or create searches your pages; the command palette lists the rest.');
  insert(welcome, 'The installed app also has a source library and reader, exports and backups. Those are not part of this local browser demo.');

  insert(journal, `Hello, today. Start with ${link(welcome, 'Welcome to Tessera')} — or put a thought of your own below.`);
  const planned = insert(journal, 'Try editing this task, then tick it off');
  const task: TaskState = { status: 'todo', scheduled: today, scheduled_time: null, deadline: today, deadline_time: null, warning_days: null, repeater: null, priority: 'medium', completed_on: null };
  operations.push({ op: 'set_task', id: planned, base_revision: 1, task });
  const anotherTask = insert(journal, `Choose a small experiment from ${link(ideas, 'Small ideas')}`);
  operations.push({ op: 'set_task', id: anotherTask, base_revision: 1, task: { ...task, deadline: null, priority: null } });
  insert(journal, 'A place for your next thought:');
  insert(journal, '');

  insert(learning, 'A few cards to try', 1);
  insert(learning, 'Cards come from ordinary block text. Edit these examples to see their syntax, then open Review.');
  insert(learning, 'Where does this demo store your notebook? >> In this browser, on this device.');
  insert(learning, 'Outline <> A thought with room for smaller thoughts beneath it.');
  insert(learning, 'A linked notebook connects {{c1::ideas}} rather than isolating them.');
  insert(learning, `Return to ${link(welcome, 'Welcome to Tessera')} whenever you want the tour.`);

  const effort = insert(fieldsPage, 'Demo effort');
  operations.push({ op: 'set_field_kind', id: effort, base_revision: 1, kind: 'number' });
  const started = insert(fieldsPage, 'Demo started');
  operations.push({ op: 'set_field_kind', id: started, base_revision: 1, kind: 'date' });
  operations.push({ op: 'set_type_fields', type_id: ideaType, base_revision: 1, fields: [effort, started] });
  insert(ideas, 'Small experiments, connected', 1);
  insert(ideas, 'These ideas have a Demo idea type and two typed fields. Open the Small experiments view in the sidebar to see the same blocks as a table.');
  const sample = (text: string, cost: string) => {
    const id = insert(ideas, text);
    operations.push({ op: 'add_type', id, base_revision: 1, title: 'Demo idea' });
    insert(insert(id, `[[${effort}]]`), cost);
    insert(insert(id, `[[${started}]]`), today);
    return id;
  };
  const garden = sample('Grow a windowsill garden', '2');
  insert(garden, 'Start with one pot, one herb and a sunny window.');
  sample('Take a ten-minute noticing walk', '1');
  insert(ideas, `An outline, a task and a card can all refer to the same thought. Back to ${link(welcome, 'Welcome to Tessera')}.`);
  operations.push({ op: 'save_view', id: ulid(), base_revision: null, name: 'Small experiments', query: { type: ideaType, text: null, filters: [], sort: [{ by: 'field', field: effort, direction: 'asc' }], limit: 100 } });
  return { actor: { kind: 'client', name: 'Tessera browser demo' }, reason: 'Restore the friendly browser tour', idempotency_key: ulid(), operations };
}
