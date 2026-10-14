import type { FieldDefinition, FieldKind, QuerySource } from '../api/types';

export const querySources: { key: QuerySource; name: string }[] = [
  { key: 'notes', name: 'Notes' }, { key: 'questions', name: 'Questions' },
  { key: 'positions', name: 'Perspectives' }, { key: 'sources', name: 'Sources' },
  { key: 'tasks', name: 'Tasks' }, { key: 'highlights', name: 'Highlights' },
];
export const sourceName = (source: QuerySource = 'notes') => querySources.find(item => item.key === source)!.name;
type Attribute = [string, string, FieldKind, string[]?];
const common: Attribute[] = [['title', 'Title', 'text'], ['page', 'Page', 'instance'], ['created', 'Created', 'date'], ['updated', 'Updated', 'date']];
const attributes: Record<QuerySource, Attribute[]> = {
  notes: [['kind', 'Kind', 'choice'], ['resolved', 'Resolved', 'checkbox'], ['revisit', 'Revisit', 'date']],
  questions: [['state', 'State', 'choice', ['active', 'recurrent', 'parked', 'answered']], ['parent', 'Parent question', 'instance'], ['program', 'Program', 'instance'], ['readings', 'Perspectives', 'number'], ['current', 'Current answer', 'text'], ['last_assessed', 'Last assessed', 'date'], ['revisit', 'Revisit', 'date'], ['inline', 'Inline', 'checkbox']],
  positions: [['holder', 'Holder', 'instance'], ['subject', 'Subject', 'instance'], ['question', 'Question', 'instance'], ['relation', 'Argument', 'choice', ['supports', 'disputes', 'qualifies', 'answers']], ['target_holder', 'Target holder', 'instance'], ['cites', 'Cites', 'instance']],
  sources: [['creator', 'Creator', 'instance'], ['cited_by', 'Cited by', 'number'], ['cited_in', 'Cited in', 'instance'], ['highlights', 'Highlights', 'number']],
  tasks: [['status', 'Status', 'choice', ['todo', 'doing', 'waiting', 'done', 'cancelled']], ['due', 'Due', 'date'], ['scheduled', 'Scheduled', 'date'], ['project', 'Project', 'instance']],
  highlights: [['source', 'Source', 'instance'], ['color', 'Color', 'choice', ['yellow', 'green', 'blue', 'red', 'purple']]],
};
/** Attributes reuse the field picker without becoming editable field definitions. */
export function attributeDefinitions(source: QuerySource = 'notes'): FieldDefinition[] {
  return [...common, ...attributes[source]].map(([key, name, kind, options]) => ({
    id: `@${key}`, name, kind, revision: 0, targets: [], options: (options ?? []).map(text => ({ id: text, text })),
  }));
}
