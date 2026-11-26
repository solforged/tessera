import { Show, createSignal } from 'solid-js';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';

export {
  createSavedViewController,
  type SavedViewController,
  type SavedViewControllerOptions,
  type SavedViewRecord,
  type SavedViewWorkshop,
} from './saved-view-controller';

export function SavedViewNamePopup(props: {
  anchor: HTMLElement;
  label: string;
  inputLabel?: string;
  placeholder?: string;
  name?: string;
  emptyMessage?: string;
  placement?: 'anchor' | 'sheet';
  width?: number;
  maxLength?: number | null;
  busy?: boolean;
  errorClass?: string;
  onDismiss(): void;
  onSave(name: string): Promise<void>;
}) {
  const initial = props.name ?? '';
  const [name, setName] = createSignal(initial);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  const working = () => !!props.busy || submitting();
  const fieldLabel = () => props.inputLabel ?? 'View name';
  const submit = async () => {
    if (working()) return;
    if (!name().trim()) {
      if (props.emptyMessage) setError(props.emptyMessage);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await props.onSave(name());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Popup
      anchor={props.anchor}
      placement={props.placement}
      label={props.label}
      width={props.width}
      dirty={() => name().trim() !== initial.trim()}
      onDismiss={props.onDismiss}
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          class="input"
          aria-label={fieldLabel()}
          placeholder={props.placeholder ?? fieldLabel()}
          value={name()}
          maxlength={props.maxLength === null ? undefined : (props.maxLength ?? 120)}
          disabled={working()}
          onInput={event => {
            setName(event.currentTarget.value);
            if (error()) setError('');
          }}
        />
        <Show when={error()}>
          <p class={props.errorClass ?? 'error'} role="alert">
            {error()}
          </p>
        </Show>
        <div class="popup-actions">
          <Button disabled={working()} onClick={props.onDismiss}>
            Cancel
          </Button>
          <Button type="submit" class="bordered" disabled={working() || (!props.emptyMessage && !name().trim())}>
            Save
          </Button>
        </div>
      </form>
    </Popup>
  );
}

export function DeleteSavedViewPopup(props: {
  anchor: HTMLElement;
  label: string;
  name: string;
  keptNoun: string;
  busy: boolean;
  error?: string;
  errorClass?: string;
  onDismiss(): void;
  onConfirm(): void;
}) {
  return (
    <Popup
      anchor={props.anchor}
      label={props.label}
      onDismiss={() => {
        if (!props.busy) props.onDismiss();
      }}
    >
      <p>
        Delete “{props.name}”? {props.keptNoun} are not deleted.
      </p>
      <Show when={props.error}>
        <p class={props.errorClass ?? 'error'} role="alert">
          {props.error}
        </p>
      </Show>
      <div class="popup-actions">
        <Button disabled={props.busy} onClick={props.onDismiss}>
          Cancel
        </Button>
        <Button class="bordered danger" disabled={props.busy} onClick={props.onConfirm}>
          Delete view
        </Button>
      </div>
    </Popup>
  );
}
