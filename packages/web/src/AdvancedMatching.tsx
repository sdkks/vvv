import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MatchingSettings, SettingsConsequence } from '@vvv/shared';
import { runMatching, SettingsValidationError, updateSettings } from './api';
import {
  consequenceMessages,
  isSizeField,
  matchingDraft,
  matchingErrors,
  matchingFields,
  matchingPayload,
  type MatchingDraft,
} from './matching-controls';

export function AdvancedMatching({ matching }: { matching: MatchingSettings }) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<MatchingDraft>();
  const [attempted, setAttempted] = useState(false);
  const [consequences, setConsequences] = useState<SettingsConsequence[]>([]);
  const saved = matchingDraft(matching);
  const values = draft ?? saved;
  const dirty = matchingFields.some(({ key }) => values[key] !== saved[key]);
  const errors = matchingErrors(values);
  const save = useMutation({
    mutationFn: updateSettings,
    onSuccess: async (result) => {
      cache.setQueryData(['settings'], result);
      setDraft(undefined);
      setAttempted(false);
      setConsequences((current) => [
        ...current.filter((c) => !result.consequences.some((next) => next.type === c.type)),
        ...result.consequences,
      ]);
      await cache.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const rematch = useMutation({
    mutationFn: runMatching,
    onSuccess: () => {
      setConsequences((current) => current.filter((c) => c.type !== 'rematch_required'));
    },
  });
  const fieldErrors = {
    ...(attempted ? errors : {}),
    ...(save.error instanceof SettingsValidationError ? save.error.fields : {}),
  };
  return (
    <details className="matching-card advanced-matching">
      <summary>Advanced matching controls</summary>
      <p>
        Lower thresholds are stricter; higher thresholds may group unrelated files. Candidate
        retrieval is approximate, especially above distance 7. Saving thresholds does not re-match.
      </p>
      <p>
        Changing frame count clears video perceptual hashes, not SHA-256 checkpoints. Videos will be
        re-sampled on the next scan; re-match afterwards. Timeout changes affect only future or
        retried sampling, not completed work.
      </p>
      <p id="size-policy-help">
        Size limits are inclusive. Leave a size input empty to disable that bound (saved as 0).
        {consequenceMessages.next_scan_required}
      </p>
      <form
        noValidate
        aria-label="Advanced matching controls"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (dirty && !Object.keys(errors).length && !save.isPending && !rematch.isPending) {
            rematch.reset();
            save.mutate(matchingPayload(values));
          }
        }}
      >
        {matchingFields.map(({ key, label, min, max }) => (
          <div className="matching-field" key={key}>
            <label htmlFor={key}>
              {label}
              {!isSizeField(key) && ` (${min}–${max})`}
            </label>
            <input
              id={key}
              type="number"
              min={min}
              max={max}
              step={key === 'video_timeout_ms' ? '0.001' : '1'}
              required={!isSizeField(key)}
              placeholder={isSizeField(key) ? 'Disabled' : undefined}
              value={values[key]}
              disabled={save.isPending || rematch.isPending}
              aria-invalid={!!fieldErrors[key]}
              aria-describedby={
                [isSizeField(key) ? 'size-policy-help' : '', fieldErrors[key] ? `${key}-error` : '']
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              onChange={(event) => {
                setDraft({ ...values, [key]: event.target.value });
                save.reset();
              }}
            />
            {isSizeField(key) && Number(values[key]) === 0 && <span>Disabled</span>}
            {fieldErrors[key] && (
              <p id={`${key}-error`} role="alert">
                {fieldErrors[key]}
              </p>
            )}
          </div>
        ))}
        <p>{dirty ? 'Unsaved matching changes.' : 'Matching controls match saved values.'}</p>
        <div className="toolbar">
          <button disabled={!dirty || save.isPending || rematch.isPending}>
            {save.isPending ? 'Saving matching…' : 'Save matching controls'}
          </button>
          <button
            type="button"
            disabled={!dirty || save.isPending || rematch.isPending}
            onClick={() => {
              setDraft(undefined);
              setAttempted(false);
              save.reset();
            }}
          >
            Discard changes
          </button>
        </div>
      </form>
      {save.isError && <p role="alert">{save.error.message}</p>}
      <div role="status" aria-live="polite">
        {save.isSuccess && <p>Matching settings saved.</p>}
        {consequences.map((c) => (
          <p key={c.type}>{consequenceMessages[c.type]}</p>
        ))}
        {rematch.isSuccess && <p>Re-match started. New results appear only when it completes.</p>}
      </div>
      {consequences.some((c) => c.type === 'rematch_required') &&
        !consequences.some(
          (c) => c.type === 'rescan_required' || c.type === 'next_scan_required'
        ) && (
          <button disabled={save.isPending || rematch.isPending} onClick={() => rematch.mutate()}>
            {rematch.isPending ? 'Starting re-match…' : 'Re-match now'}
          </button>
        )}
      {rematch.isError && <p role="alert">{rematch.error.message}</p>}
    </details>
  );
}
