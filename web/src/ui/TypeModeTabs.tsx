import { Button } from './Button';

export interface TypeModeTabsProps {
  active: 'index' | 'table' | 'fields' | 'cards';
  indexCount: number | undefined;
  tableCount: number | undefined;
  fieldsCount: number | undefined;
  cardsCount: number | undefined;
  onIndex(event: MouseEvent): void;
  onTable(event: MouseEvent): void;
  onFields(event: MouseEvent): void;
  onCards(event: MouseEvent): void;
}

/** A type's finding aid, member table and template share one navigation strip. */
export function TypeModeTabs(props: TypeModeTabsProps) {
  return <div class="type-mode-tabs mode-tabs tab-strip" data-mode-panel=":scope > :first-child" role="group" aria-label="Tag view">
    <Button aria-pressed={props.active === 'index'} onClick={props.onIndex}>Index <span class="faint">{props.indexCount}</span></Button>
    <Button aria-pressed={props.active === 'table'} onClick={props.onTable}>Table <span class="faint">{props.tableCount}</span></Button>
    {/* Fields and Cards count the type's template, not its members' entries, so an empty template shows no count. */}
    <Button aria-pressed={props.active === 'fields'} onClick={props.onFields} title="Fields in this tag's template">Fields <span class="faint">{props.fieldsCount || ''}</span></Button>
    <Button aria-pressed={props.active === 'cards'} onClick={props.onCards} title="Card recipes for this tag">Cards <span class="faint">{props.cardsCount || ''}</span></Button>
  </div>;
}
