/**
 * JSON shapes of the service API (snake_case, as serialized). `wire.ts` is
 * written from the Rust types by `mise run wire`; the shapes below it are
 * the ones the editor makes itself, each derived from a generated type.
 */
export type * from './wire';
import type { CardTemplate, LibraryQuery, SurfacingBody } from './wire';

/** A card template as the editor edits it: the service assigns the id, position, revision and timestamps. */
export type CardTemplateState = Omit<CardTemplate, 'id' | 'position' | 'revision' | 'created_at' | 'updated_at'>;

/**
 * The browse filters the library pane keeps and spreads into a `LibraryQuery`: AND across fields, OR within one;
 * empty means no filter. `people` holds person page ids.
 */
export type LibraryFilters = {
  [Field in 'people' | 'decades' | 'years' | 'publishers' | 'languages']-?: NonNullable<LibraryQuery[Field]>;
};

/** What a person did with a resurfaced highlight. */
export type SurfacingAction = SurfacingBody['action'];
