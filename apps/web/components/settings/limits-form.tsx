'use client';

import { useState, type ReactNode } from 'react';
import type { UnitCosts } from '@liedmotif/shared';
import type { UsageLimits } from '@liedmotif/db';
import { useAppChrome } from '@/components/app-chrome-context';
import { TimezoneSelect } from '@/components/timezone-select';
import { Stepper, Switch } from '@/components/ui/controls';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { saveUsageLimits } from '@/lib/settings-client';
import { toast } from '@/lib/toast';
import { normalizeTracksPerRequest } from '@/lib/track-units';
import { PricedQuantity, pricedStepperClass } from './cost-readout';
import {
  buildLimitsPatch,
  createLimitFormValues,
  formatStorageQuota,
  limitFieldMax,
  limitFieldMin,
  limitFieldSwitchedOff,
  limitFieldWarnings,
  stepLimitValue,
  STORAGE_STEP_BYTES,
  type LimitFieldErrors,
  type LimitFormField,
  type LimitFormValues,
} from './limits-form-model';
import { SettingsCard, SettingsControlRow, SettingsFootnote, SettingsSection } from './settings-ui';

const SAVE_KEY = 'usage-limits-save';

export function LimitsForm({
  initial,
  tracksPerRequest,
  unitCosts,
}: {
  initial: UsageLimits;
  tracksPerRequest: number;
  unitCosts: UnitCosts;
}) {
  const [values, setValues] = useState(() => createLimitFormValues(initial, tracksPerRequest));
  const [errors, setErrors] = useState<LimitFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const { fetchChrome } = useAppChrome();
  const trackYield = normalizeTracksPerRequest(tracksPerRequest);
  const warnings = limitFieldWarnings(values);

  function change<K extends keyof LimitFormValues>(field: K, value: LimitFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    if (field in errors) {
      setErrors((current) => {
        const next = { ...current };
        delete next[field as LimitFormField];
        return next;
      });
    }
  }

  function step(field: LimitFormField, amount: number) {
    change(
      field,
      stepLimitValue(
        values[field],
        amount,
        limitFieldMax(field, tracksPerRequest),
        limitFieldMin(field, tracksPerRequest),
      ),
    );
  }

  function pricedValue(raw: string, unit: 'Tracks' | 'Covers'): ReactNode {
    return <PricedQuantity quantity={Number(raw)} unit={unit} costs={unitCosts} />;
  }

  async function save() {
    if (saving) return;
    toast.dismiss(SAVE_KEY);
    const parsed = buildLimitsPatch(values, tracksPerRequest);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      toast.error('Check the highlighted limit values.', { key: SAVE_KEY });
      return;
    }

    setErrors({});
    setSaving(true);
    const result = await saveUsageLimits(parsed.patch);
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error, { key: SAVE_KEY });
      return;
    }
    toast.success('Generation and cost limits saved.', { key: SAVE_KEY });
    // The sidebar headroom chip is shell state that otherwise refreshes only
    // on navigation.
    void fetchChrome();
  }

  const saveButton = (
    <button
      type="button"
      onClick={() => void save()}
      disabled={saving}
      className={`${primaryButtonClass} mt-4 w-full`}
    >
      {saving ? 'Saving…' : 'Save limits'}
    </button>
  );

  return (
    <>
      <SettingsSection id="cost-controls" title="Cost controls">
        <SettingsCard>
          <SettingsControlRow label="Instance timezone">
            <TimezoneSelect
              value={values.resetTimezone}
              onChange={(next) => change('resetTimezone', next)}
              ariaLabel="Instance timezone"
              disabled={saving}
              triggerClassName="max-w-[190px]"
            />
          </SettingsControlRow>
          <SettingsControlRow
            label="Limit my Tracks"
            description="Caps your own generation per day and month · Members keep their own budget"
          >
            <Switch
              checked={values.trackCeilingEnabled}
              onCheckedChange={(checked) => change('trackCeilingEnabled', checked)}
              disabled={saving}
              aria-label="Limit my Tracks"
            />
          </SettingsControlRow>
          <LimitStepperRow
            label="Daily limit"
            value={pricedValue(values.dailyTracks, 'Tracks')}
            field="dailyTracks"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.dailyTracks}
            step={trackYield * 5}
            error={errors.dailyTracks}
            warning={warnings.dailyTracks}
            disabled={saving || limitFieldSwitchedOff('dailyTracks', values)}
            onStep={step}
          />
          <LimitStepperRow
            label="Monthly limit"
            value={pricedValue(values.monthlyTracks, 'Tracks')}
            field="monthlyTracks"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.monthlyTracks}
            step={trackYield * 25}
            error={errors.monthlyTracks}
            warning={warnings.monthlyTracks}
            disabled={saving || limitFieldSwitchedOff('monthlyTracks', values)}
            onStep={step}
          />
          <LimitStepperRow
            label="Generating at once"
            value={`${values.concurrentTracks} trk`}
            field="concurrentTracks"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.concurrentTracks}
            step={trackYield}
            error={errors.concurrentTracks}
            disabled={saving}
            onStep={step}
          />
          <LimitStepperRow
            label="Max queued Tracks"
            description="Ready-ahead ceiling per Session"
            value={`${values.maxQueuedTracks} trk`}
            field="maxQueuedTracks"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.maxQueuedTracks}
            step={1}
            error={errors.maxQueuedTracks}
            disabled={saving}
            onStep={step}
          />
          <LimitStepperRow
            label="Headroom to start"
            description="Below this, Start Session and More Like This are gated"
            value={`${values.minHeadroomTracksToStartSession} trk`}
            field="minHeadroomTracksToStartSession"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.minHeadroomTracksToStartSession}
            step={1}
            error={errors.minHeadroomTracksToStartSession}
            disabled={saving}
            onStep={step}
          />
          <LimitStepperRow
            label="Idle auto-stop"
            description="A paused Session stops generating after this long"
            value={`${values.idleAutoStopAfterMinutes} min`}
            field="idleAutoStopAfterMinutes"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.idleAutoStopAfterMinutes}
            step={5}
            error={errors.idleAutoStopAfterMinutes}
            disabled={saving}
            onStep={step}
          />
          <LimitStepperRow
            label="Storage quota"
            value={formatStorageQuota(values.storageQuotaBytes)}
            field="storageQuotaBytes"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.storageQuotaBytes}
            step={STORAGE_STEP_BYTES}
            error={errors.storageQuotaBytes}
            disabled={saving}
            onStep={step}
          />
          <SettingsControlRow
            label="Pause all new music"
            description="Stops all music generation, including a new Session's first Tracks"
          >
            <Switch
              checked={values.manualGenerationOnly}
              onCheckedChange={(checked) => change('manualGenerationOnly', checked)}
              disabled={saving}
              aria-label="Pause all new music"
            />
          </SettingsControlRow>
          <SettingsFootnote>
            A Session that reaches a limit repeats its own Tracks instead of stopping. Zero is a
            valid limit and deliberately blocks that kind of generation.
          </SettingsFootnote>
        </SettingsCard>
        {saveButton}
      </SettingsSection>

      <SettingsSection title="Cover art budget">
        <SettingsCard>
          <SettingsControlRow
            label="Generate Tailored Cover Art"
            description="Needs an image provider; off, Covers come from Suno instead — drawn from the music alone, without the chosen Cover style"
          >
            <Switch
              checked={values.tailoredCoverArtEnabled}
              onCheckedChange={(checked) => change('tailoredCoverArtEnabled', checked)}
              disabled={saving}
              aria-label="Generate Tailored Cover Art"
            />
          </SettingsControlRow>
          <SettingsControlRow
            label="Limit my Covers"
            description="Caps your own Covers per day and month · Members keep their own budget"
          >
            <Switch
              checked={values.coverCeilingEnabled}
              onCheckedChange={(checked) => change('coverCeilingEnabled', checked)}
              disabled={saving}
              aria-label="Limit my Covers"
            />
          </SettingsControlRow>
          <LimitStepperRow
            label="Covers per day"
            value={pricedValue(values.generatedCoversPerDay, 'Covers')}
            field="generatedCoversPerDay"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.generatedCoversPerDay}
            step={5}
            error={errors.generatedCoversPerDay}
            disabled={saving || limitFieldSwitchedOff('generatedCoversPerDay', values)}
            onStep={step}
          />
          <LimitStepperRow
            label="Covers per month"
            value={pricedValue(values.generatedCoversPerMonth, 'Covers')}
            field="generatedCoversPerMonth"
            tracksPerRequest={tracksPerRequest}
            rawValue={values.generatedCoversPerMonth}
            step={50}
            error={errors.generatedCoversPerMonth}
            disabled={saving || limitFieldSwitchedOff('generatedCoversPerMonth', values)}
            onStep={step}
          />
          <SettingsFootnote>
            These ceilings cap every generated Cover, including the Suno Covers a Session gets with
            Tailored Cover Art off.
          </SettingsFootnote>
        </SettingsCard>
        {saveButton}
      </SettingsSection>
    </>
  );
}

function LimitStepperRow({
  label,
  description,
  value,
  field,
  rawValue,
  step,
  tracksPerRequest,
  error,
  warning,
  disabled,
  onStep,
}: {
  label: string;
  description?: string;
  value: ReactNode;
  field: LimitFormField;
  rawValue: string;
  step: number;
  tracksPerRequest: number;
  error?: string;
  /** A hint that never blocks the save; an error outranks it. */
  warning?: string;
  disabled: boolean;
  onStep: (field: LimitFormField, amount: number) => void;
}) {
  const numericValue = Number(rawValue);
  const max = limitFieldMax(field, tracksPerRequest);
  const min = limitFieldMin(field, tracksPerRequest);
  return (
    <SettingsControlRow
      label={label}
      description={
        error || warning ? <span className="text-warn">{error ?? warning}</span> : description
      }
    >
      <Stepper
        className={pricedStepperClass}
        value={value}
        onDecrement={() => onStep(field, -step)}
        onIncrement={() => onStep(field, step)}
        decrementLabel={`Decrease ${label}`}
        incrementLabel={`Increase ${label}`}
        canDecrement={!disabled && Number.isFinite(numericValue) && numericValue > min}
        canIncrement={!disabled && Number.isFinite(numericValue) && numericValue < max}
      />
    </SettingsControlRow>
  );
}
