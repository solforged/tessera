import { Button } from './Button';

export interface TypeModeTabsProps {
  active: 'index' | 'table' | 'fields' | 'cards';
  indexCount: number;
  tableCount: number;
  fieldsCount: number;
  cardsCount: number;
  onIndex(event: MouseEvent): void;
  onTable(event: MouseEvent): void;
  onFields(event: MouseEvent): void;
  onCards(event: MouseEvent): void;
}

/** A type's finding aid, member table and template share one navigation strip. */
export function TypeModeTabs(props: TypeModeTabsProps) {
  return <div class="type-mode-tabs mode-tabs tab-strip" role="group" aria-label="Type view">
    <Button aria-pressed={props.active === 'index'} onClick={props.onIndex}>Index <span class="faint">{props.indexCount}</span></Button>
    <Button aria-pressed={props.active === 'table'} onClick={props.onTable}>Table <span class="faint">{props.tableCount}</span></Button>
    <Button aria-pressed={props.active === 'fields'} onClick={props.onFields}>Fields <span class="faint">{props.fieldsCount}</span></Button>
    <Button aria-pressed={props.active === 'cards'} onClick={props.onCards}>Cards <span class="faint">{props.cardsCount}</span></Button>
  </div>;
}
