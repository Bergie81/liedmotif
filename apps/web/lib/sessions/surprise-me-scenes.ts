// The situations Surprise Me writes its requests around, per theme, in the
// spirit of the Describe field's example prompts; `any` is its own wider list of
// offbeat topics rather than a mix of the themes. Each sets the request's
// energy and length; `genres` is the music only when learned taste has none to
// offer. `local` is the same situation set in the owner's city, at `{city}`.
//
// With a text LLM these do not become the request: a theme hands the model its
// `subject`, and an `any` topic is the seed it writes a fresh request from.

import type { EnergyLevel, SurpriseTheme } from '@liedmotif/shared';

export interface SurpriseScene {
  text: string;
  local?: string;
  energy: EnergyLevel;
  minutes: number;
  genres: readonly string[];
}

export interface SurpriseThemeContent {
  /** What the text LLM writes about; null for `any`, whose picked topic is the subject. */
  subject: string | null;
  scenes: readonly SurpriseScene[];
}

export const SURPRISE_THEME_CONTENT: Record<SurpriseTheme, SurpriseThemeContent> = {
  any: {
    subject: null,
    scenes: [
      {
        text: 'A heist planned on a rainy night, everything timed to the second',
        energy: 'medium',
        minutes: 30,
        genres: ['trip-hop', 'cinematic'],
      },
      {
        text: 'The deep sea, the lights fading as the submarine sinks',
        energy: 'low',
        minutes: 40,
        genres: ['ambient', 'drone'],
      },
      {
        text: 'A tiny bar in Tokyo where the owner only plays vinyl',
        energy: 'low',
        minutes: 45,
        genres: ['jazz', 'lounge'],
      },
      {
        text: 'A robot slowly learning to dance',
        energy: 'medium',
        minutes: 30,
        genres: ['synthwave', 'funk'],
      },
      {
        text: 'The last ferry of the summer leaving a Greek island',
        energy: 'medium',
        minutes: 40,
        genres: ['bossa-nova', 'acoustic'],
      },
      {
        text: 'A space station, a sunrise every ninety minutes',
        energy: 'low',
        minutes: 45,
        genres: ['ambient', 'cinematic'],
      },
      {
        text: 'A 1970s road movie through the desert, dust and sunglasses',
        energy: 'medium',
        minutes: 40,
        genres: ['rock', 'blues'],
      },
      {
        text: 'A greenhouse at midnight, plants growing in time-lapse',
        energy: 'low',
        minutes: 40,
        genres: ['neoclassical', 'ambient'],
      },
      {
        text: 'A market at dusk, spices, motorbikes and a hundred conversations',
        energy: 'medium',
        minutes: 40,
        genres: ['afrobeats', 'downtempo'],
      },
      {
        text: 'An old radio picking up stations from another decade',
        energy: 'low',
        minutes: 30,
        genres: ['lofi', 'soul'],
      },
      {
        text: 'A Nordic fishing village in the polar night',
        energy: 'low',
        minutes: 45,
        genres: ['folk', 'ambient'],
      },
      {
        text: 'A secret rooftop rave, the police three streets away',
        local: 'A secret rooftop rave above {city}, the police three streets away',
        energy: 'high',
        minutes: 30,
        genres: ['techno', 'house'],
      },
      {
        text: "A detective's office, a flickering neon sign, a case that won't close",
        energy: 'low',
        minutes: 40,
        genres: ['jazz', 'trip-hop'],
      },
      {
        text: 'A thunderstorm rolling in across the open plains',
        energy: 'medium',
        minutes: 30,
        genres: ['cinematic', 'rock'],
      },
      {
        text: 'A dragon asleep under a mountain of gold',
        energy: 'low',
        minutes: 40,
        genres: ['orchestral', 'cinematic'],
      },
      {
        text: 'The first day of the summer holidays, age twelve',
        energy: 'high',
        minutes: 25,
        genres: ['pop', 'indie'],
      },
      {
        text: 'A cyberpunk night market, rain and holograms',
        local: '{city} in 2089, a night market of rain and holograms',
        energy: 'medium',
        minutes: 40,
        genres: ['synthwave', 'techno'],
      },
      {
        text: 'A monastery above the clouds, bells and wind',
        energy: 'low',
        minutes: 45,
        genres: ['new-age', 'drone'],
      },
      {
        text: 'A carnival parade, drums coming from every side',
        energy: 'high',
        minutes: 30,
        genres: ['afrobeats', 'reggaeton'],
      },
      {
        text: "A lighthouse keeper's last night before the light goes automatic",
        energy: 'low',
        minutes: 40,
        genres: ['folk', 'piano'],
      },
    ],
  },
  morning: {
    subject: 'a morning moment: waking up, first coffee, the commute, early light',
    scenes: [
      {
        text: 'Waking up slowly, curtains still closed, no alarm',
        energy: 'low',
        minutes: 30,
        genres: ['ambient', 'piano'],
      },
      {
        text: 'First coffee of the day, the kitchen still quiet',
        local: 'First coffee of the day in {city}, the kitchen still quiet',
        energy: 'low',
        minutes: 20,
        genres: ['lofi', 'jazz'],
      },
      {
        text: 'Getting ready and out the door, running five minutes late',
        energy: 'medium',
        minutes: 20,
        genres: ['funk', 'soul'],
      },
      {
        text: 'Slow weekend breakfast, windows open, nowhere to be',
        energy: 'low',
        minutes: 30,
        genres: ['bossa-nova'],
      },
      {
        text: 'Cycling to work on a bright, cold morning',
        local: 'Cycling to work through {city} on a bright, cold morning',
        energy: 'medium',
        minutes: 30,
        genres: ['indie', 'acoustic'],
      },
      {
        text: 'Morning stretch on the floor, sun coming through the blinds',
        energy: 'low',
        minutes: 20,
        genres: ['new-age', 'ambient'],
      },
      {
        text: 'An early start at the desk before anyone else is online',
        energy: 'medium',
        minutes: 25,
        genres: ['deep-house'],
      },
      {
        text: 'Sunrise over the rooftops, the city not awake yet',
        local: 'Sunrise over the rooftops of {city}, nobody awake yet',
        energy: 'low',
        minutes: 40,
        genres: ['neoclassical', 'piano'],
      },
    ],
  },
  focus: {
    subject: 'a stretch of focused work, study, reading or making something',
    scenes: [
      {
        text: 'Deep focus for a long stretch, nothing that pulls at me',
        energy: 'low',
        minutes: 60,
        genres: ['ambient', 'piano'],
      },
      {
        text: 'Late-night studying, keep me awake but calm',
        local: 'Late-night studying in {city}, keep me awake but calm',
        energy: 'low',
        minutes: 45,
        genres: ['lofi', 'jazz'],
      },
      {
        text: 'Reading something difficult on a grey afternoon, one lamp on',
        energy: 'low',
        minutes: 50,
        genres: ['neoclassical', 'piano'],
      },
      {
        text: "Admin work I've been avoiding, keep me moving without noticing the time",
        energy: 'medium',
        minutes: 40,
        genres: ['deep-house', 'downtempo'],
      },
      {
        text: 'Coding late into the night, one problem and nothing else',
        energy: 'low',
        minutes: 45,
        genres: ['ambient', 'soundscape'],
      },
      {
        text: 'Working from a busy café, I need a wall of sound around me',
        local: 'Working from a busy café in {city}, I need a wall of sound around me',
        energy: 'medium',
        minutes: 40,
        genres: ['lofi', 'chillhop'],
      },
      {
        text: 'A long writing session, I need to disappear for a while',
        energy: 'low',
        minutes: 60,
        genres: ['neoclassical', 'cinematic'],
      },
      {
        text: 'Sketching ideas on paper, let them flow',
        energy: 'medium',
        minutes: 30,
        genres: ['downtempo', 'trip-hop'],
      },
    ],
  },
  movement: {
    subject: 'moving the body: running, training, cycling, hiking, swimming, dancing',
    scenes: [
      {
        text: 'Steady run, one unbroken pace',
        local: 'Steady run through the streets of {city}, one unbroken pace',
        energy: 'high',
        minutes: 30,
        genres: ['drum-and-bass'],
      },
      {
        text: 'Last minutes of a workout, everything hurts',
        energy: 'high',
        minutes: 15,
        genres: ['techno'],
      },
      {
        text: 'Cycling into a headwind on a flat, open road',
        energy: 'medium',
        minutes: 45,
        genres: ['synthwave'],
      },
      {
        text: 'Cool-down and stretching after a heavy session, bring me back down slowly',
        energy: 'low',
        minutes: 15,
        genres: ['downtempo', 'ambient'],
      },
      {
        text: 'Heavy lifting session, steady and relentless',
        energy: 'high',
        minutes: 45,
        genres: ['house', 'techno'],
      },
      {
        text: 'A long hike up a ridge, the valley opening below',
        energy: 'medium',
        minutes: 60,
        genres: ['synthwave', 'downtempo'],
      },
      {
        text: 'Dance workout in the living room, furniture pushed aside',
        energy: 'high',
        minutes: 30,
        genres: ['afrobeats', 'reggaeton'],
      },
      {
        text: 'Swimming laps in an empty pool, weightless and rhythmic',
        energy: 'medium',
        minutes: 40,
        genres: ['deep-house'],
      },
    ],
  },
  travel: {
    subject: 'being on the way somewhere: driving, trains, flights, ferries, walking a new city',
    scenes: [
      {
        text: 'Night drive, empty motorway, rain on the windscreen',
        local: 'Night drive out of {city}, empty motorway, rain on the windscreen',
        energy: 'medium',
        minutes: 45,
        genres: ['synthwave'],
      },
      {
        text: 'Window seat, climbing out through the clouds into flat morning sun',
        energy: 'low',
        minutes: 40,
        genres: ['ambient', 'cinematic'],
      },
      {
        text: 'First train of the day through fog, still half asleep',
        local: 'First train of the day through {city}, fog outside, still half asleep',
        energy: 'low',
        minutes: 30,
        genres: ['lofi', 'downtempo'],
      },
      {
        text: "Walking around a city I don't know with nowhere to be",
        energy: 'medium',
        minutes: 45,
        genres: ['bossa-nova', 'jazz'],
      },
      {
        text: 'Overnight train, lights off, towns passing in the dark',
        energy: 'low',
        minutes: 60,
        genres: ['ambient', 'cinematic'],
      },
      {
        text: 'Hour six of a road trip, everyone has stopped talking, the light going orange',
        energy: 'medium',
        minutes: 45,
        genres: ['indie', 'folk'],
      },
      {
        text: 'Bus home after a long day, forehead against the window',
        local: 'Bus home through {city} after a long day, forehead against the window',
        energy: 'low',
        minutes: 30,
        genres: ['lofi', 'chillhop'],
      },
      {
        text: 'Ferry to an island, sun on the deck, salt in the air',
        energy: 'medium',
        minutes: 30,
        genres: ['reggae', 'bossa-nova'],
      },
    ],
  },
  home: {
    subject: 'an ordinary moment at home: cooking, cleaning, a slow weekend, a rainy evening',
    scenes: [
      {
        text: 'Slow Sunday cooking, nowhere to be',
        energy: 'medium',
        minutes: 60,
        genres: ['soul', 'funk'],
      },
      {
        text: 'Cleaning the whole flat in the hour before guests arrive',
        energy: 'high',
        minutes: 30,
        genres: ['funk', 'disco'],
      },
      {
        text: 'Sunday coffee, rain on the windows, no plans for the day',
        local: 'Sunday coffee in {city}, rain on the windows, no plans for the day',
        energy: 'low',
        minutes: 45,
        genres: ['lofi', 'jazz'],
      },
      {
        text: 'Folding laundry and letting my brain go completely blank',
        energy: 'low',
        minutes: 20,
        genres: ['chillhop'],
      },
      {
        text: 'Repainting the bedroom, ladder out, paint everywhere',
        energy: 'medium',
        minutes: 45,
        genres: ['indie', 'pop'],
      },
      {
        text: 'Cooking a slow dinner for one, a glass of wine, no rush',
        energy: 'low',
        minutes: 40,
        genres: ['jazz', 'soul'],
      },
      {
        text: 'Clearing out the garage on a bright Saturday',
        energy: 'medium',
        minutes: 30,
        genres: ['rock', 'indie'],
      },
      {
        text: 'Rainy evening on the sofa with a book, tea going cold',
        local: 'Rainy evening in {city}, on the sofa with a book, tea going cold',
        energy: 'low',
        minutes: 60,
        genres: ['ambient', 'piano'],
      },
    ],
  },
  friends: {
    subject: 'time with other people: a dinner, a party, getting ready to go out, a long evening',
    scenes: [
      {
        text: 'Dinner party background, nobody should listen to it',
        energy: 'low',
        minutes: 60,
        genres: ['lounge', 'bossa-nova'],
      },
      {
        text: 'Getting ready to go out, first drink poured',
        local: 'Getting ready for a night out in {city}, first drink poured',
        energy: 'high',
        minutes: 30,
        genres: ['house', 'disco'],
      },
      {
        text: 'Garden barbecue in the late afternoon as the light goes golden',
        energy: 'medium',
        minutes: 60,
        genres: ['afrobeats', 'reggae'],
      },
      {
        text: 'House party at one in the morning, when everyone has stopped being polite',
        energy: 'high',
        minutes: 40,
        genres: ['house', 'techno'],
      },
      {
        text: 'Cooking together, too many people in a small kitchen',
        energy: 'medium',
        minutes: 60,
        genres: ['funk', 'soul'],
      },
      {
        text: 'Board games with old friends, nobody checking their phone',
        energy: 'medium',
        minutes: 60,
        genres: ['indie', 'rock'],
      },
      {
        text: 'Pre-drinks before a night out, the volume slowly creeping up',
        local: 'Pre-drinks before a night out in {city}, the volume slowly creeping up',
        energy: 'high',
        minutes: 30,
        genres: ['reggaeton', 'afrobeats'],
      },
      {
        text: 'Late night around a campfire, the conversation getting honest',
        energy: 'low',
        minutes: 45,
        genres: ['folk', 'acoustic'],
      },
    ],
  },
  rest: {
    subject: 'resting: winding down, napping, falling asleep, a bath, doing nothing',
    scenes: [
      {
        text: 'Falling asleep, nothing that ever arrives anywhere',
        energy: 'low',
        minutes: 60,
        genres: ['ambient', 'drone'],
      },
      {
        text: 'Meditation, one unbroken texture',
        energy: 'low',
        minutes: 20,
        genres: ['drone', 'new-age'],
      },
      {
        text: 'Winding down after far too long in front of screens',
        energy: 'low',
        minutes: 30,
        genres: ['ambient', 'piano'],
      },
      {
        text: 'Afternoon nap in a patch of sun, half awake the whole time',
        energy: 'low',
        minutes: 20,
        genres: ['new-age', 'soundscape'],
      },
      {
        text: 'Half an hour in the bath after a long week',
        energy: 'low',
        minutes: 30,
        genres: ['ambient', 'piano'],
      },
      {
        text: 'Lying in the grass watching clouds, thinking about nothing',
        energy: 'low',
        minutes: 45,
        genres: ['soundscape', 'ambient'],
      },
      {
        text: 'Something quiet and endlessly repeating for a baby to fall asleep to',
        energy: 'low',
        minutes: 60,
        genres: ['drone', 'ambient'],
      },
      {
        text: 'Sunday evening, slowly letting the week go',
        energy: 'low',
        minutes: 30,
        genres: ['new-age', 'piano'],
      },
    ],
  },
  mood: {
    subject: 'a feeling stated as a reason: good news, a bad day, nerves, missing someone',
    scenes: [
      {
        text: 'I got the news I was hoping for, let me feel it',
        energy: 'high',
        minutes: 20,
        genres: ['funk', 'soul'],
      },
      {
        text: "Everything went wrong today. Don't cheer me up, just sit with me",
        energy: 'low',
        minutes: 30,
        genres: ['blues', 'piano'],
      },
      {
        text: 'Nervous before something big tomorrow, steady my hands',
        energy: 'medium',
        minutes: 30,
        genres: ['downtempo', 'neoclassical'],
      },
      {
        text: 'First properly warm day of the year, windows open',
        local: 'First properly warm day of the year in {city}, windows open',
        energy: 'medium',
        minutes: 40,
        genres: ['bossa-nova', 'soul'],
      },
      {
        text: 'Missing someone who lives a long way away',
        energy: 'low',
        minutes: 40,
        genres: ['soul', 'blues'],
      },
      {
        text: 'Angry and I want to burn it off, not talk about it',
        energy: 'high',
        minutes: 20,
        genres: ['rock', 'pop'],
      },
      {
        text: 'Quietly proud of something nobody else noticed',
        energy: 'medium',
        minutes: 30,
        genres: ['indie', 'folk'],
      },
      {
        text: 'The last evening before moving away, bittersweet',
        local: 'The last evening in {city} before moving away, bittersweet',
        energy: 'low',
        minutes: 40,
        genres: ['cinematic', 'piano'],
      },
    ],
  },
  place: {
    subject: 'a vivid place or image the music should paint',
    scenes: [
      {
        text: 'An abandoned amusement park in winter',
        energy: 'low',
        minutes: 30,
        genres: ['cinematic', 'ambient'],
      },
      {
        text: 'A lighthouse in a storm, watched from a warm kitchen window',
        energy: 'medium',
        minutes: 30,
        genres: ['neoclassical', 'cinematic'],
      },
      {
        text: 'A ferry crossing flat grey water at dawn',
        energy: 'low',
        minutes: 40,
        genres: ['ambient', 'downtempo'],
      },
      {
        text: 'Snow falling over a village where every light is already off',
        local: 'Snow falling over {city} after every light has gone off',
        energy: 'low',
        minutes: 40,
        genres: ['piano', 'ambient'],
      },
      {
        text: 'A rooftop at golden hour',
        local: 'A rooftop in {city} at golden hour',
        energy: 'medium',
        minutes: 40,
        genres: ['deep-house'],
      },
      {
        text: 'A desert at night under a sky full of stars',
        energy: 'low',
        minutes: 40,
        genres: ['ambient', 'cinematic'],
      },
      {
        text: 'A smoky basement jazz bar after closing time',
        energy: 'medium',
        minutes: 30,
        genres: ['jazz', 'lounge'],
      },
      {
        text: 'A night market in the rain, lanterns and steam',
        local: 'A night market in {city}, rain, lanterns and steam',
        energy: 'low',
        minutes: 40,
        genres: ['lofi', 'ambient'],
      },
    ],
  },
  'about-me': {
    subject:
      'a sung song about the listener themself, phrased as "a song about me"; the lyric writer knows the listener, you do not, so name no facts about their life',
    scenes: [
      {
        text: 'A sung song about me',
        local: 'A sung song about me and my life in {city}',
        energy: 'medium',
        minutes: 30,
        genres: ['acoustic', 'indie'],
      },
      {
        text: 'A sung song about my week, the good parts and the rest',
        energy: 'medium',
        minutes: 30,
        genres: ['pop', 'indie'],
      },
      {
        text: 'A sung song about home',
        local: 'A sung song about home and the streets of {city}',
        energy: 'medium',
        minutes: 30,
        genres: ['folk', 'acoustic'],
      },
      {
        text: 'A sung, upbeat song about the things I love most',
        energy: 'high',
        minutes: 20,
        genres: ['funk', 'soul'],
      },
      {
        text: 'A sung, gentle song about what keeps me going',
        energy: 'low',
        minutes: 30,
        genres: ['singer-songwriter', 'piano'],
      },
    ],
  },
};
