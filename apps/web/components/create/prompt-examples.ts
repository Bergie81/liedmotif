// The home screen's Describe field teaches by demonstration: each load types
// one real example prompt into the empty field as its placeholder. The
// examples are chosen to teach specific expansion behaviours (situation beats
// adjectives, instrumental by default, request language becomes sung language,
// briefings work, a bounded activity can name its length), not merely to look
// varied. Open-ended ones stay open-ended: continuous play is the default.
//
// The animation follows the decode-sweep shape (`../player/title-scramble.ts`):
// exported frame constants, a pure "give me frame N" function, and a pure
// "what comes after frame N" function, driven by a thin client hook.

export const PROMPT_EXAMPLES: readonly string[] = [
  // Focus and work
  'Deep focus, three hours, nothing that pulls at me…',
  'Late-night studying, one more hour, keep me awake but calm…',
  "Admin work I've been avoiding for a week — one solid hour, keep me moving without noticing the time",
  'Ninety minutes reading something difficult on a grey afternoon, warm room, one lamp on',
  'Long writing session, the kind where I need to disappear for four hours.\n\nNo drums, no vocals, nothing with a hook I could catch myself humming. Think one slowly shifting texture — piano and strings that never quite resolve. It should be possible to forget it is playing and still miss it when it stops.',
  // Movement and sport
  'Steady hour-long run, one unbroken pace…',
  'Last ten minutes of a workout, everything hurts…',
  'Fifteen minutes of cool-down and stretching after a heavy session — bring me back down slowly',
  '90 minutes cycling into a headwind on a flat, open road with nothing on the horizon',
  '40-minute early swim before work, weightless and rhythmic, the pool still empty',
  // Travel and commute
  '90-minute night drive, empty motorway, rain on the windscreen…',
  'Window seat on a two-hour flight, climbing out through the clouds into flat morning sun',
  'Forty minutes on the first train of the day through fog, still half asleep, coffee too hot to drink',
  "Two hours walking around a city I don't know with no map and nowhere to be",
  'Hour six of a long road trip. Everyone in the car has stopped talking.\n\nFlat landscape, the light going orange, still two hundred kilometres to go. I want something that makes the distance feel good instead of long — spacious, forward-moving, a little bit wistful. No vocals, nothing that demands attention from whoever is driving.',
  // Home and routine
  'Slow Sunday cooking, about two hours, nowhere to be…',
  'Cleaning the whole flat in the hour before guests arrive…',
  'Sunday coffee, rain on the windows, no plans for the entire day',
  'Twenty minutes folding laundry and deliberately letting my brain go completely blank',
  'Half an hour in the bath after a week that took more out of me than it should have',
  // People and social
  'Dinner party background for the next three hours — nobody should listen to it…',
  'Getting ready to go out, 45 minutes, first drink poured…',
  'Four-hour garden barbecue in the late afternoon as the light starts going golden',
  'House party at one in the morning, when everyone has stopped being polite',
  'Three hours of board games with old friends, warm room, unhurried, nobody checking their phone',
  // Rest and sleep
  'Falling asleep — nothing that ever arrives anywhere…',
  'Twenty minutes of meditation, one unbroken texture…',
  'Half an hour winding down after far too long in front of screens',
  'Something quiet for a baby to fall asleep to, soft and endlessly repeating',
  'Twenty-minute afternoon nap in a patch of sun, half awake the whole time',
  // Mood, stated as a reason
  'I got the news I was hoping for — let me feel it…',
  "Everything went wrong today. Don't cheer me up, just sit with me",
  'Nervous before something big tomorrow — steady my hands, keep me level',
  "Missing someone who lives a long way away and won't be back soon",
  'First properly warm day of the year, windows open for the first time since autumn',
  // When you already know the sound
  'Dusty desert blues, one guitar, a lot of space…',
  '1970s soul with warm horns and a groove that sounds tired but hopeful',
  'Late-90s drum and bass, dark rolling bassline, nothing sped up or cheerful',
  'Baroque strings, a very small ensemble, recorded in a cold stone church',
  'Synthwave for a city that only exists after midnight.\n\nWet asphalt, neon reflected in it, one car moving. Analogue pads, a slow arpeggio underneath, drums that stay in the background instead of driving. More melancholy than action-movie — this is the drive home, not the chase.',
  // Scenes and images
  'An abandoned amusement park in winter…',
  'A lighthouse in a storm, watched from a warm kitchen window',
  'The last hour of a festival, the field emptying out, everything a bit broken',
  'A ferry crossing flat grey water at dawn, engines humming below deck',
  'Snow falling slowly over a village where every light is already off',
  // Songs for people — these want vocals, and they want detail
  'Sung birthday song for my mother turning 60 — warm, a little bit funny, not sentimental',
  'A sung wedding song for two friends getting married in the summer.\n\n- They met at university and took nine years to admit it\n- She is a nurse, he teaches history and is a terrible cook\n- The wedding is outdoors, small, mostly family\n- The joke everyone makes is that he proposed twice because he forgot the ring the first time\n\nGentle, acoustic, funny in the verses and genuinely warm in the chorus.',
  'A sung farewell song for a colleague leaving after eighteen years.\n\nShe was the person who quietly fixed everything before anyone noticed it was broken, trained half the team, and never once took credit. She is retiring to the coast to finally have time for her garden.\n\nAffectionate and upbeat rather than sad — this should be sung badly by a whole office and still work.',
  "A sung, slightly silly children's song about a cat that keeps escaping through the window",
  'A sung song for our amateur football team, to be played before matches.\n\nWe have lost more than we have won for six seasons and keep turning up anyway. Half the squad is over forty. The pitch floods every November. The chorus should be simple enough that twenty people can shout it out of tune together.\n\nLoud, stubborn, proud — a song about showing up, not about winning.',
];

/** Constant total duration, not constant speed: every example finishes in
 * TYPE_TOTAL_FRAMES × TYPE_FRAME_MS (~2s), so a briefing advances several
 * characters per frame while a fragment advances less than one. */
export const TYPE_TOTAL_FRAMES = 50;
export const TYPE_FRAME_MS = 40;

/** The index to show next: uniform over the pool, never repeating the
 * last-shown index unless the pool has a single entry. An absent or
 * out-of-range `lastIndex` degrades to an unconstrained pick. */
export function pickExampleIndex(
  pool: readonly string[],
  lastIndex: number | null,
  random: () => number,
): number {
  if (pool.length <= 1) return 0;
  const excluded =
    lastIndex != null && Number.isInteger(lastIndex) && lastIndex >= 0 && lastIndex < pool.length
      ? lastIndex
      : null;
  if (excluded == null) return Math.floor(random() * pool.length);
  const pick = Math.floor(random() * (pool.length - 1));
  return pick >= excluded ? pick + 1 : pick;
}

/** Frame N of the typing animation: always a genuine prefix of the target —
 * never a churned character, because the point is legibility. Frame zero is
 * empty; the final frame is the target exactly. */
export function typedFrame(target: string, frame: number): string {
  if (frame >= TYPE_TOTAL_FRAMES) return target;
  return target.slice(0, Math.floor((target.length * frame) / TYPE_TOTAL_FRAMES));
}

/** The frame after `frame`, or null once the typing has finished. */
export function nextTypedFrame(frame: number): number | null {
  return frame < TYPE_TOTAL_FRAMES ? frame + 1 : null;
}
