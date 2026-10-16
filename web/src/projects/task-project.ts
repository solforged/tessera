import { createMemo, createResource } from 'solid-js';
import type { NotebookClient, PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';

/** Match the core's first live Project value, then the nearest project ancestor. */
export function taskProject(doc: PageDocument, id: string, definitions: ReadonlySet<string>, active: ReadonlySet<string>): string | null {
  for (const entryId of doc.outline.children(id)) {
    const entry = doc.block(entryId);
    if (!entry || entry.archived || !definitions.has(fieldEntryId(entry.text) ?? '')) continue;
    for (const valueId of doc.outline.children(entryId)) {
      const value = doc.block(valueId);
      const project = value && !value.archived ? fieldEntryId(value.text) : null;
      if (project && active.has(project)) return project;
    }
  }
  let parent = doc.block(id)?.parentId;
  while (parent) {
    const block = doc.block(parent);
    if (block?.project && !block.archived) return parent;
    parent = block?.parentId;
  }
  return null;
}

export function createTaskProjects(doc: PageDocument, notebook: NotebookClient) {
  const [metadata] = createResource(() => [notebook.changeSequence(), notebook.connection() === 'live'] as const, async () => {
    const [fields, projects] = await Promise.all([notebook.api.fields(), notebook.api.projects()]);
    return { fields: fields.fields, projects };
  });
  const active = createMemo(() => new Set(metadata.error ? [] : metadata()?.projects.map(project => project.block_id) ?? []));
  const definitions = createMemo(() => new Set(metadata.error ? [] : metadata()?.fields.filter(field => field.name.toLowerCase() === 'project' && field.kind === 'instance').map(field => field.id) ?? []));
  return {
    metadata,
    project: (id: string) => taskProject(doc, id, definitions(), active()),
  };
}
