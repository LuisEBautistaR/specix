/** A small floating form for workspace actions (new API, new version). */
import { useState, type FormEvent } from "react";

export interface Field {
  name: string;
  label: string;
  value: string;
  /** A select instead of a text input. */
  options?: Array<{ value: string; label: string }>;
  hint?: string;
  mono?: boolean;
}

interface Props {
  title: string;
  fields: Field[];
  submit: string;
  error: string | null;
  onSubmit(values: Record<string, string>): void;
  onCancel(): void;
}

export function FormDialog({ title, fields, submit, error, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value])));
  const send = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(values);
  };
  return (
    <div className="dialog-layer" role="presentation" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <form className="dialog" role="dialog" aria-label={title} onSubmit={send} data-testid="form-dialog">
        <h3>{title}</h3>
        {fields.map((f, i) => (
          <label key={f.name} className="field">
            <span>{f.label}</span>
            {f.options ? (
              <select value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} data-testid={`field-${f.name}`}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={f.mono ? "mono" : undefined}
                value={values[f.name]}
                autoFocus={i === 0}
                spellCheck={false}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                data-testid={`field-${f.name}`}
              />
            )}
            {f.hint && <small>{f.hint}</small>}
          </label>
        ))}
        {error && <p className="dialog-error err-t">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="dialog-submit">
            {submit}
          </button>
        </div>
      </form>
    </div>
  );
}
