// `changeSetting`: changes one of the asking user's own settings, through the
// function its settings page saves with. Every setting here is a choice that
// cannot raise what is spent, so a change runs at once.

import {
  getCoverReferenceFrequency,
  getGenerationSettings,
  getPlaybackSettings,
  listPeople,
  listPersonReferencePhotos,
  updateCoverReferenceFrequency,
  updateDefaultLanguage,
  updatePlaybackSettings,
  type CoverReferenceFrequency,
} from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  ASSISTANT_SETTINGS,
  changeSettingInputSchema,
  CROSSFADE_SECONDS_MAX,
  CROSSFADE_SECONDS_MIN,
  type AssistantSetting,
  type ChangeSettingInput,
} from '@liedmotif/shared';
import {
  COVER_FREQUENCY_OPTIONS,
  ownerCoverFallbackReady,
} from '@/components/settings/people-form-model';
import { toPersonRoster } from '@/lib/settings/people';
import { SESSION_LANGUAGE_CHOICES, sessionLanguageLabel } from '@/lib/sessions/session-languages';
import { done, refused } from './library-action';
import { orList, SETTING_NAMES } from './setting-names';
import { CHANGE_SETTING_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { ActionOutcome, TurnActions } from './turn-actions';

/** One setting: the choices it takes, and how the asker's own is read and stored. */
interface Setting<Value> {
  /** The choices, as the model is told them. */
  choices: string;
  /** Why the setting cannot be changed for the asker yet, or null when it can. */
  unavailable?(asker: AssistantAsker): Promise<string | null>;
  /** The choice the model named, or null when the setting has no such choice. */
  parse(said: string): Value | null;
  /** A choice as the settings page shows it. */
  show(value: Value): string;
  read(asker: AssistantAsker): Promise<Value>;
  write(asker: AssistantAsker, value: Value): Promise<unknown>;
}

/** A setting the tool can change: its choices, and the change itself. */
interface Changeable {
  choices: string;
  change(asker: AssistantAsker, said: string): Promise<ActionOutcome<'done'>>;
}

/** `spec` as the tool uses it: what the model said is refused, or stored and receipted. */
function changeable<Value>(setting: AssistantSetting, spec: Setting<Value>): Changeable {
  const { label } = SETTING_NAMES[setting];
  return {
    choices: spec.choices,
    async change(asker, said) {
      const unavailable = await spec.unavailable?.(asker);
      if (unavailable) return refused(unavailable);
      const value = spec.parse(said.trim());
      if (value === null) return refused(`"${label}" takes ${spec.choices}.`);
      const previous = await spec.read(asker);
      if (previous === value) return refused(`"${label}" is already ${spec.show(value)}.`);
      await spec.write(asker, value);
      return done({
        action: 'changeSetting',
        setting,
        value: spec.show(value),
        previous: spec.show(previous),
      });
    },
  };
}

/** The one of `choices` that `said` names by one of its `names`, whatever its case. */
const oneOf = <Choice extends string>(
  choices: readonly Choice[],
  said: string,
  names: (choice: Choice) => string[] = (choice) => [choice],
): Choice | null =>
  choices.find((choice) =>
    names(choice).some((name) => name.toLowerCase() === said.toLowerCase()),
  ) ?? null;

/** A whole number of seconds the crossfade slider has, with or without its unit, or null. */
function crossfadeSeconds(said: string): number | null {
  const whole = /^(\d+)\s*(?:s|sec|secs|seconds?)?$/i.exec(said);
  const seconds = whole ? Number(whole[1]) : NaN;
  return seconds >= CROSSFADE_SECONDS_MIN && seconds <= CROSSFADE_SECONDS_MAX ? seconds : null;
}

const coverFrequencyLabel = (value: CoverReferenceFrequency) =>
  COVER_FREQUENCY_OPTIONS.find((option) => option.value === value)?.label ?? value;

const SETTINGS: Record<AssistantSetting, Changeable> = {
  ownerInCovers: changeable<CoverReferenceFrequency>('ownerInCovers', {
    choices: orList(COVER_FREQUENCY_OPTIONS.map(({ label }) => label)),
    // The People page holds this at Never until the asker's own card has a
    // photo: a Cover takes their likeness, and no other Person's stands in.
    unavailable: async ({ db, userId }) => {
      const [people, photos] = await Promise.all([
        listPeople(db, userId),
        listPersonReferencePhotos(db, { ownerUserId: userId }),
      ]);
      return ownerCoverFallbackReady(toPersonRoster(people, photos))
        ? null
        : `"${SETTING_NAMES.ownerInCovers.label}" stays at Never until the user's own card in Settings › People has a reference photo: they add one there first.`;
    },
    parse: (said) =>
      oneOf(
        COVER_FREQUENCY_OPTIONS.map(({ value }) => value),
        said,
      ),
    show: coverFrequencyLabel,
    read: ({ db, userId }) => getCoverReferenceFrequency(db, userId),
    write: ({ db, userId }, value) => updateCoverReferenceFrequency(db, userId, value),
  }),
  blend: changeable('blend', {
    choices: 'on or off',
    parse: (said) => {
      const choice = oneOf(['on', 'off'], said);
      return choice === null ? null : choice === 'on';
    },
    show: (on) => (on ? 'On' : 'Off'),
    read: async ({ db, userId }) => (await getPlaybackSettings(db, userId)).blendEnabled,
    write: ({ db, userId }, blendEnabled) =>
      updatePlaybackSettings(db, { ownerUserId: userId, patch: { blendEnabled } }),
  }),
  crossfadeSeconds: changeable('crossfadeSeconds', {
    choices: `a whole number of seconds from ${CROSSFADE_SECONDS_MIN} to ${CROSSFADE_SECONDS_MAX}`,
    parse: crossfadeSeconds,
    show: (seconds) => `${seconds} s`,
    read: async ({ db, userId }) => (await getPlaybackSettings(db, userId)).crossfadeSeconds,
    write: ({ db, userId }, seconds) =>
      updatePlaybackSettings(db, { ownerUserId: userId, patch: { crossfadeSeconds: seconds } }),
  }),
  defaultLanguage: changeable('defaultLanguage', {
    choices: orList(SESSION_LANGUAGE_CHOICES.map(sessionLanguageLabel)),
    // By the name the select shows, or by the stored one: "auto", "Chinese".
    parse: (said) =>
      oneOf(SESSION_LANGUAGE_CHOICES, said, (choice) => [choice, sessionLanguageLabel(choice)]),
    show: sessionLanguageLabel,
    read: async ({ db, userId }) => (await getGenerationSettings(db, userId)).defaultLanguage,
    write: ({ db, userId }, language) => updateDefaultLanguage(db, userId, language),
  }),
};

/** Each setting by the name the model passes, with its label and its choices. */
const SETTINGS_LIST = ASSISTANT_SETTINGS.map(
  (name) => `${name} ("${SETTING_NAMES[name].label}": ${SETTINGS[name].choices})`,
).join('; ');

export function createChangeSettingTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ChangeSettingInput> {
  return {
    name: CHANGE_SETTING_TOOL_NAME,
    description: `Changes one of the user's own settings to a new choice. The settings and their choices: ${SETTINGS_LIST}.`,
    inputSchema: changeSettingInputSchema,
    execute: ({ setting, value }) =>
      actions.take('done', () => SETTINGS[setting].change(asker, value)),
  };
}
