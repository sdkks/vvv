import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RetentionSettings, Settings as Policy } from '@vvv/shared';
import { getSettings, updateSettings } from './api';
import { policySummary, validRetention } from './trash-state';
import { PageHeading } from './PageHeading';
import { MatchingBehavior } from './MatchingBehavior';
import { AdvancedMatching } from './AdvancedMatching';

export function Settings() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: getSettings, retry: false });
  const [draft, setDraft] = useState<RetentionSettings>();
  const save = useMutation({
    mutationFn: updateSettings,
    onSuccess: (policy) => {
      cache.setQueryData<Policy>(['settings'], (current) =>
        current ? { ...current, ...policy } : undefined
      );
      setDraft(undefined);
      void cache.invalidateQueries({ queryKey: ['trash'] });
    },
  });
  const policy = draft ?? query.data;
  return (
    <>
      <PageHeading>Settings</PageHeading>
      {query.isPending && <p role="status">Loading settings…</p>}
      {query.isError && (
        <p role="alert">
          {query.error.message} <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {query.data && <MatchingBehavior matching={query.data.matching} />}
      {query.data && <AdvancedMatching matching={query.data.matching} />}
      {query.data && <p>{policySummary(query.data)}</p>}
      {policy && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (validRetention(policy.retention_days) && !save.isPending)
              save.mutate({
                retention_days: policy.retention_days,
                auto_purge_enabled: policy.auto_purge_enabled,
              });
          }}
        >
          <label htmlFor="retention">Retention days (1–3650)</label>
          <input
            id="retention"
            type="number"
            min="1"
            max="3650"
            step="1"
            required
            disabled={save.isPending}
            value={Number.isNaN(policy.retention_days) ? '' : policy.retention_days}
            onChange={(event) =>
              setDraft({ ...policy, retention_days: event.target.valueAsNumber })
            }
          />
          <label className="scan-option">
            <input
              type="checkbox"
              checked={policy.auto_purge_enabled}
              disabled={save.isPending}
              onChange={(event) => {
                const enabled = event.target.checked;
                if (
                  !enabled ||
                  window.confirm(
                    `Enable automatic permanent deletion after ${policy.retention_days} days? This includes files already in Trash. Deletion cannot be undone. Save settings to activate.`
                  )
                )
                  setDraft({ ...policy, auto_purge_enabled: enabled });
              }}
            />
            Automatically purge expired files
          </label>
          <p>
            Enabling auto-purge permanently deletes expired files, including existing Trash. This
            cannot be undone.
          </p>
          <button disabled={save.isPending || !validRetention(policy.retention_days)}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </form>
      )}
      {save.isError && <p role="alert">{save.error.message}</p>}
      {save.isSuccess && !draft && <p role="status">Settings saved.</p>}
    </>
  );
}
