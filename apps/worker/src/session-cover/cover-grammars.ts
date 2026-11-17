import type { PresetStyle, StyleGrammar } from './cover-plan-selection';

// The per-style art-direction vocabulary the Session Cover planner composes
// prompts from. Pure data: every axis entry is provider-facing prompt prose,
// so wording changes here are behavior changes and ride the prompt version
// declared in cover-plan.ts.

// Shared opener for reference treatments that keep the person recognizable; the
// exact phrase is a load-bearing contract marker (tests key on "preserve
// recognizable" to distinguish these from identity-only abstracted treatments).
const PRESERVED_IDENTITY =
  'preserve recognizable facial structure, hairstyle, age, and salient identity features';

export const GRAMMARS: Record<PresetStyle, StyleGrammar> = {
  record_sleeve: {
    required:
      'album cover artwork in the style of one decade between the 1960s and the 2000s, full-bleed. Take the decade from the Session Name, scene, or music context: a named decade or year, or an era-rooted genre or sound, in any language; only when none evokes one, use the fallback decade from the concept treatment. Make it the way covers were made then, not a modern pastiche: 1960s spot-color inks, mod or psychedelic forms; 1970s warm saturated film, airbrush, soft focus; 1980s glossy flash, neon and pastel, chrome, grids; 1990s grainy flash, photocopy collage, grunge or rave color; 2000s slick digital compositing, high gloss, lens flare. One decade carried through every element; the image is the artwork itself, never a physical record, border, or frame',
    forbidden: [
      'a photographed vinyl record, CD, sleeve mockup, or packaging shot',
      'mixing the looks of several decades in one image',
      'a recreation of a specific existing album cover',
      'a white or colored border, frame, paper margin, or rounded corners around the artwork',
      'a timeless modern look with no clear decade',
      'empty title panels, blank text areas, or monogram letters',
      'anonymous silhouette when a subject reference is supplied',
    ],
    modes: [
      'fallback decade 1960s, used only when nothing evokes another',
      'fallback decade 1970s, used only when nothing evokes another',
      'fallback decade 1980s, used only when nothing evokes another',
      'fallback decade 1990s, used only when nothing evokes another',
      'fallback decade 2000s, used only when nothing evokes another',
    ],
    subjects: [
      'a theme-derived focal subject staged the way a cover of that decade would show it',
      'a recognizable human figure engaged with the theme, posed and photographed or painted as a period cover subject',
      'a theme-charged object or place treated as a period cover image',
    ],
    compositions: [
      'one full-bleed period image with a single dominant focal subject',
      'a centered figure or object on a period-typical ground',
      "a bold off-center crop typical of that decade's cover design",
    ],
    palettes: [
      "a theme-derived palette true to the chosen decade's printing",
      'a softened period palette',
      'a saturated period palette with one strong accent',
      'a restrained period palette with deep blacks',
    ],
    materials: [
      'the film grain or print texture of that decade',
      'period photo grain or paint texture',
      'visible halftone or print texture true to the chosen decade',
      "the color response of that decade's film stock or inks",
    ],
    lighting: [
      'lighting true to the photography or illustration of the chosen decade',
      'period studio lighting',
      'natural light captured with a period photo process',
      'flat graphic light for an illustrated cover',
    ],
    referenceTreatments: [
      `${PRESERVED_IDENTITY}; portray the person as the cover subject of an album from the chosen decade, styled, lit, and printed in that era, making them the focal portrait subject when the theme centers them`,
      'preserve recognizable identity as a figure within the period cover scene; the chosen decade controls styling, photo process, and print without erasing facial likeness',
    ],
    energy: {
      low: 'a calm, unhurried cover with room to breathe',
      medium: 'confident period styling with one clear focal pull',
      high: 'bold, loud period energy with strong contrast and movement',
    },
  },
  photographic: {
    required:
      'a believable single-exposure photograph with explicit optics, physical light, natural imperfections, and one honest moment — an album cover photograph, not a stock image, rendering, or composite',
    forbidden: [
      'illustration or painted rendering',
      'polished CGI or composite sheen',
      'sterile stock-photo styling',
      'plastic over-retouched skin',
      'anonymous silhouette when a subject reference is supplied',
    ],
    modes: [
      'environmental portrait',
      'studio portrait with sculpted light',
      'candid documentary moment',
      'cinematic narrative still',
      'quiet landscape or architectural study',
      'material still life with deliberate optics',
    ],
    subjects: [
      'a theme-derived focal subject photographed in its real environment with described optics',
      'a recognizable human figure engaged with the theme, photographed as the clear focal subject',
      'a theme-charged object, place, or texture isolated by depth of field',
    ],
    compositions: [
      'off-center documentary frame with layered depth',
      'centered portrait framing with shallow depth of field',
      'wide negative-space frame holding one small focal subject',
    ],
    palettes: [
      'a theme-derived natural palette with one true-to-life accent',
      'rain-muted blue and amber',
      'golden-hour warmth against deep shadow',
      'night exposure with sodium and neon color over true blacks',
      'high-key daylight neutrals',
      'dense monochrome with rich blacks',
    ],
    materials: [
      '35mm film grain with subtle halation',
      'medium-format clarity with smooth tonal falloff',
      'pushed high-ISO grain with deep contrast',
      'daylight-balanced digital capture with honest color',
      'cross-processed color shift and gentle bloom',
      'slightly soft vintage-lens rendering with a natural vignette',
    ],
    lighting: [
      'overcast window light',
      'low golden-hour backlight through haze',
      'hard on-camera flash at night',
      'one motivated practical source in darkness',
      'single-light studio chiaroscuro',
      'stage backlight through atmosphere',
    ],
    referenceTreatments: [
      `${PRESERVED_IDENTITY}; photograph the person with the selected optics, process, and light, making them the focal portrait subject when the theme centers them and otherwise placing them naturally within the scene`,
      'preserve recognizable identity in a candid or posed photographic moment; the selected process controls grain, color, and light without erasing facial likeness',
    ],
    energy: {
      low: 'long-exposure stillness and settled air',
      medium: 'a caught in-between moment with subtle motion',
      high: 'handheld urgency with motion blur and direct flash',
    },
  },
  minimal: {
    required:
      'one dominant theme-derived motif held in generous negative space, a restricted flat palette of two or three colors, immediate hierarchy readable at thumbnail size, and the material presence of a printed or fabricated object',
    forbidden: [
      'detailed scenery',
      'collage',
      'ornamental density',
      'more than three colors',
      'decorative texture noise filling the negative space',
      'anonymous silhouette when a subject reference is supplied',
    ],
    modes: [
      'single emblem',
      'reduced trace or data mark',
      'color-field with material relief',
      'isolated object study',
      'reduced two-tone portrait',
      'flat geometric construction',
    ],
    subjects: [
      'a theme-derived motif reduced to its simplest recognizable geometric form',
      'a single theme-charged object isolated on a seamless one-color ground',
      'a recognizable human figure reduced to a flat two- or three-tone graphic portrait',
      'one continuous drawn or embossed line that traces the theme',
    ],
    compositions: [
      'a small motif in a vast quiet field, placed off-center with deliberate asymmetric balance',
      'one centered emblem with generous symmetrical breathing room',
      'one edge-entering form against open space',
      'a single horizon-line division of two flat fields with one focal interruption',
    ],
    palettes: [
      'a theme-derived two-color pairing with one restrained accent',
      'ink black and warm paper white with one cobalt accent',
      'a single saturated field with one tone-on-tone relief',
      'charcoal, sand, and muted coral',
      'deep navy, pale gray, and one amber note',
      'two flat complementary planes and one neutral',
    ],
    materials: [
      'screen-print ink on uncoated stock with honest edge bleed',
      'blind emboss on heavy matte card',
      'flat pigment with subtle paper grain',
      'seamless studio paper with one controlled cast shadow',
      'single-ink stencil-duplicator grain on rough stock',
      'cut card with a single precise cast shadow',
    ],
    lighting: [
      'soft even illumination that keeps every plane flat',
      'one restrained directional shadow',
      'raking light revealing embossed or debossed relief',
      'clean seamless studio light with gentle falloff',
    ],
    referenceTreatments: [
      `${PRESERVED_IDENTITY}; reduce the person to a flat high-contrast two- or three-tone graphic portrait held in generous negative space, centered when the theme centers them`,
      'preserve recognizable identity as a small but fully identifiable figure placed in a vast quiet field; the restricted palette and print material control everything else',
    ],
    energy: {
      low: 'near-static balance and settled emptiness',
      medium: 'one measured directional gesture',
      high: 'one taut diagonal interruption of the quiet field',
    },
  },
  drawing: {
    required:
      'a real hand-made drawing on a single plain sheet of drawing paper, presented as a flat evenly lit scan filling the frame edge to edge — visible mark-making with pressure variation, drawn tonal values, and the tooth of the paper; a finished album-cover drawing holding one dominant motif on a deliberately designed ground, not a digital illustration or a filtered photo',
    forbidden: [
      'photography or a photo run through a sketch filter',
      'polished CGI or digital-painting smoothness',
      'uniform vector line weight',
      'a photographed desk scene, hands, drawing tools, or page edges around the artwork',
      'handwriting, initials, or margin notes',
      'anonymous silhouette when a subject reference is supplied',
    ],
    modes: [
      'fine-line pen-and-ink illustration',
      'high-contrast brush-ink figure',
      'naive marker or crayon emblem',
      'lyrical contour line with one watercolor pocket',
      'tonal graphite or charcoal portrait study',
      'wordless comic-inked scene',
    ],
    subjects: [
      'a theme-derived focal subject drawn by hand as the single dominant motif',
      'a recognizable human figure engaged with the theme, drawn as the clear focal subject',
      'a theme-charged object or creature drawn at emblem scale on a designed flat ground',
    ],
    compositions: [
      'one dominant motif composed against all four edges of the square',
      'a single centered frontal figure at emblem scale on a flat one-color ground',
      'a tight film-still crop of one drawn figure',
      'an economical off-center figure with clean paper as open air',
      'all-over dense linework anchored by one large focal form',
    ],
    palettes: [
      'a theme-derived restricted drawing palette against paper white',
      'ink black on warm paper white',
      'black line over one flat spot-color ground',
      'graphite grays with one red-pencil accent',
      'walnut-sepia ink with one washed watercolor pocket',
      'flat saturated comic color inside brush-inked outlines',
    ],
    materials: [
      'dip-pen cross-hatching and stipple on smooth illustration board',
      'loaded brush and india ink with dry-brush breakup',
      'graphite pressure, fingertip smudging, and eraser lifts on toothy paper',
      'felt marker or wax crayon holding one wobbly unbroken contour',
      'ink contour with watercolor bleeding into the paper fibers',
      'charcoal and chalk on toned paper',
    ],
    lighting: [
      'tonal modeling built from layered hatching in one consistent light direction',
      'flat unshaded line with the paper itself as the light',
      'ink-density contrast with paper white kept as the highlight',
      'a smudged tonal vignette emerging from a dark ground',
    ],
    referenceTreatments: [
      `${PRESERVED_IDENTITY}; redraw the person entirely in the selected drawing medium so nothing photographic remains — likeness carried by facial structure, proportions, hairline, and head shape, with all light and shadow re-created as drawn marks — making them the focal portrait subject when the theme centers them`,
      'preserve recognizable identity as a hand-drawn figure within the scene; the selected medium controls every mark, tone, and texture without erasing facial likeness',
    ],
    energy: {
      low: 'spare deliberate strokes with closed confident contours',
      medium: 'varied pressure and rhythmic hatching',
      high: 'urgent overlapping strokes and dry-brush speed without losing the single dominant motif',
    },
  },
  manga: {
    required:
      'a dynamic black-and-white manga composition featuring expressive characters — bold, fluid ink lines with tapered pressure, dramatic shading in solid blacks and screentone, and stark positive and negative space driving a high-contrast visual flow; one finished full-bleed splash image holding a single dominant focal figure or motif, not a comic page',
    forbidden: [
      'speech bubbles, sound-effect lettering, or captions',
      'multi-panel comic page layout or panel borders',
      'color, tinted washes, or soft airbrushed gradients',
      'polished 3D render or cel-shaded CGI',
      'muddy gray midtones without solid blacks',
      'anonymous silhouette when a subject reference is supplied',
    ],
    modes: [
      'expressive character close-up',
      'dynamic action pose with speed lines',
      'quiet atmospheric splash panel',
      'dramatic low-angle character shot',
      'wind-swept figure against open sky',
      'intimate reflective character moment',
    ],
    subjects: [
      'a theme-derived expressive character drawn in ink as the single dominant figure',
      'a recognizable human figure engaged with the theme, inked as the clear focal character',
      'a theme-charged object or place drawn at splash scale with one small expressive figure',
    ],
    compositions: [
      'one full-bleed splash composition with a single dominant figure',
      'a dramatic diagonal with speed lines converging on the focal subject',
      'an extreme close crop on an expressive face and eyes',
      'a small figure set against a vast field of solid black or open white',
    ],
    palettes: [
      'a theme-derived balance of solid ink black and clean paper white',
      'pure ink black on bright paper white',
      'ink black and white with one layer of fine dot screentone',
      'large solid-black fields with white-line reversal',
      'black and white with a gradient screentone sky',
    ],
    materials: [
      'G-pen ink lines with tapered stroke ends on smooth manuscript paper',
      'brush-pen ink with dry-brush breakup in the shadows',
      'hand-cut dot screentone layered over crisp linework',
      'scratched-in screentone highlights and white-ink accents',
    ],
    lighting: [
      'hard rim light carved out of solid black',
      'stark chiaroscuro built from solid black shadow shapes',
      'high-key white with ink-only modeling',
      'backlit glow rendered with radiating lines and screentone',
    ],
    referenceTreatments: [
      `${PRESERVED_IDENTITY}; redraw the person entirely as a black-and-white manga character so nothing photographic remains — likeness carried by facial structure, hairstyle, and proportions in confident ink lines — making them the focal figure when the theme centers them`,
      'preserve recognizable identity as an inked manga figure within the scene; ink line, solid blacks, and screentone control every tone without erasing facial likeness',
    ],
    energy: {
      low: 'a still, contemplative frame with wide breathing space and fine lines',
      medium: 'flowing hair, cloth, and line rhythm guiding the eye through the frame',
      high: 'explosive speed lines, dynamic foreshortening, and impact framing without clutter',
    },
  },
  poster_art: {
    required:
      'strong graphic hierarchy, one arresting visual metaphor, and a complete full-frame composition that communicates at thumbnail size',
    forbidden: [
      'tiny fake credits',
      'uncontrolled lettering',
      'generic badge, app icon, or isolated pictogram',
      'undirected decorative clutter',
      'anonymous silhouette when a subject reference is supplied',
    ],
    modes: [
      'bold symbolic illustration',
      'expressive hand-painted figurative poster',
      'graphic photomontage and cut paper',
      'modernist geometric poster',
      'surreal visual-metaphor poster',
      'tactile screen-printed gig poster',
    ],
    subjects: [
      'a theme-derived focal subject rendered as a bold symbolic image',
      'a recognizable expressive figure embedded in the theme environment',
      'layered photographic, painted, or cut-paper fragments that reveal the theme through juxtaposition',
    ],
    compositions: [
      'asymmetric full-frame composition with decisive scale contrast and deliberate negative space',
      'dynamic diagonal composition that focuses the eye on one thematic visual metaphor',
      'monumental central or edge-cropped focal image with rhythmic supporting shapes',
    ],
    palettes: [
      'a theme-derived restricted palette with one high-contrast accent',
      'two saturated inks against warm uncoated paper',
      'deep nocturnal tones with one luminous weather accent',
      'muted print colors interrupted by one urgent signal color',
      'high-key complementary colors anchored by dark structural shapes',
      'earthy painted color with one vivid emotional accent',
    ],
    materials: [
      'screen-print ink and uncoated paper',
      'lithographic ink, paper tooth, and subtle registration drift',
      'torn photographic fragments, cut-paper edges, and overprinted color',
      'opaque gouache and dry-brush marks on fibrous paper',
      'coarse halftone photography with flat ink shapes',
      'layered painted shapes with tactile print grain',
    ],
    lighting: [
      'flat graphic contrast with no photographic studio lighting',
      'hard tonal separation that keeps the focal image legible at thumbnail size',
      'one cast-shape shadow used as part of the graphic composition',
      'luminous color contrast expressed through ink rather than realistic lighting',
    ],
    referenceTreatments: [
      `${PRESERVED_IDENTITY}; translate the person into the selected poster medium, making them focal when the theme centers them and otherwise integrating them as a supporting figure`,
      'preserve recognizable identity in a bold graphic portrait or environmental figure; let the selected poster treatment control palette and surface without erasing facial likeness',
    ],
    energy: {
      low: 'monumental stillness with controlled negative space',
      medium: 'rhythmic shape movement with a stable focal hierarchy',
      high: 'dynamic diagonals, cropping, and scale contrast without visual clutter',
    },
  },
};
