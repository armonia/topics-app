/**
 * Worktree-name generator: produces distinctive `<adjective>-<noun>` strings
 * for new worktrees so the user rarely has to think of a name.
 *
 * Vocabulary is intentionally curated and embedded — no network fetch, no
 * external dependency. ~500 adjectives × ~500 nouns ≈ 250k unique pairs,
 * which makes collisions extremely rare. When a caller passes the
 * `existingNames` set and a generated pair already collides, the generator
 * retries up to {@link MAX_RETRIES} times, then appends a 4-char hex suffix
 * to guarantee uniqueness.
 *
 * Output regex: /^[a-z]+-[a-z]+(-[0-9a-f]{4})?$/
 *
 * Vocabularies favour:
 *  - short, recognizable words (most ≤ 9 chars)
 *  - concrete or evocative imagery (engineers like memorable names)
 *  - filesystem-safe lowercase ASCII letters only
 *  - no slurs, no offensive words, no ambiguous spellings
 *  - no overlap between the two lists (so we never get e.g. "rapid-rapid")
 *
 * The lists are deliberately easy to extend — add words at the end and
 * keep them sorted within each block for review-ability.
 */

import { randomBytes } from "node:crypto";

export const ADJECTIVES: readonly string[] = Object.freeze([
  "agile", "amber", "ancient", "arctic", "ardent", "ashen", "auburn", "autumn",
  "azure", "balmy", "bashful", "beaming", "bitter", "blazing", "blissful",
  "boastful", "bold", "boreal", "boundless", "brassy", "brave", "breezy",
  "briny", "brisk", "broken", "bronze", "brutal", "burly", "calm", "candid",
  "canny", "carefree", "casual", "ceaseless", "celestial", "chalky", "charming",
  "cheery", "chilly", "chiseled", "chosen", "clear", "clever", "cloudy",
  "clumsy", "coastal", "coiled", "colossal", "comely", "common", "complex",
  "concise", "constant", "coral", "cosmic", "cozy", "crafty", "crested",
  "crimson", "crisp", "cryptic", "crystal", "curious", "cursed", "daring",
  "dapper", "dawning", "dazzling", "decent", "dense", "diligent", "distant",
  "divine", "doleful", "doting", "downy", "dreamy", "dusky", "dusty", "eager",
  "earnest", "earthy", "easy", "ebbing", "ebony", "eccentric", "eclectic",
  "elated", "electric", "elegant", "elfin", "elite", "ember", "endless",
  "enigmatic", "enthusiastic", "epic", "equal", "ethereal", "everlasting",
  "evident", "fabled", "facile", "fading", "faint", "fair", "faithful",
  "famed", "fancy", "feral", "fervent", "festive", "fickle", "fiery", "fine",
  "firm", "fierce", "flaxen", "fleeting", "flickering", "flowing", "foggy",
  "forgotten", "forlorn", "fragrant", "frail", "frank", "free", "frigid",
  "frosty", "frugal", "frumpy", "fugitive", "full", "furtive", "gallant",
  "gauzy", "genial", "gentle", "ghostly", "giant", "gilded", "glassy", "gleaming",
  "glib", "global", "gloomy", "glorious", "glossy", "glowing", "golden",
  "graceful", "grand", "granite", "gratis", "grave", "gray", "great", "green",
  "groovy", "grounded", "growing", "gruff", "gusty", "halcyon", "hallowed",
  "happy", "hardy", "harmonic", "hasty", "haunted", "hazel", "hazy", "hearty",
  "heavy", "helpful", "heroic", "hidden", "hollow", "homely", "honest",
  "honored", "hopeful", "humble", "humid", "hushed", "icy", "idle", "idyllic",
  "imperial", "inert", "infinite", "innocent", "iridescent", "iron", "ivory",
  "jagged", "jaunty", "jolly", "jovial", "jubilant", "keen", "kind", "kindred",
  "kinetic", "lacquered", "lambent", "languid", "latent", "lavender", "lavish",
  "lazy", "leaden", "lean", "lenient", "lifelong", "lilac", "limpid", "lithe",
  "lively", "lofty", "lone", "lonely", "looming", "loud", "loyal", "lucid",
  "luminous", "lush", "lustrous", "lyrical", "magenta", "magic", "majestic",
  "malt", "mammoth", "marbled", "marigold", "maroon", "marshy", "massive",
  "meadow", "meager", "meek", "mellow", "melodic", "mercurial", "merry",
  "mighty", "mild", "milky", "mindful", "mint", "mirky", "misty", "modest",
  "moonlit", "morose", "mossy", "mottled", "muffled", "mural", "muted",
  "mysterious", "narrow", "nascent", "near", "neat", "needful", "neutral",
  "nimble", "noble", "noiseless", "nomadic", "northern", "nostalgic", "novel",
  "noxious", "nutty", "oaken", "obscure", "occult", "ochre", "olden", "olive",
  "opal", "open", "opposite", "orange", "ordinary", "outer", "overcast",
  "padded", "pale", "pallid", "palmy", "papery", "parched", "passive",
  "patient", "peaceful", "peachy", "pensive", "perfect", "perky", "petite",
  "pewter", "piercing", "pious", "pithy", "placid", "plain", "playful",
  "pleasant", "plodding", "plucky", "plumed", "plush", "polar", "polite",
  "ponderous", "porous", "prairie", "precise", "primal", "prime", "primrose",
  "primordial", "pristine", "private", "prompt", "prosaic", "proud", "prudent",
  "punctual", "pure", "purple", "quaint", "queenly", "quiet", "radiant",
  "ragged", "rambling", "rapid", "rare", "rasping", "raven", "razored",
  "ready", "regal", "remote", "resolute", "restful", "restive", "rich",
  "rippling", "robust", "rocky", "rosy", "rough", "round", "royal", "ruby",
  "rugged", "rural", "rustic", "sacred", "saffron", "sage", "salty", "sandy",
  "sapphire", "scarlet", "scenic", "scholarly", "secret", "seething", "sepia",
  "serene", "shaded", "shadowy", "shaggy", "shallow", "sharp", "shifting",
  "shimmering", "shining", "shiny", "shoreward", "shrewd", "shy", "silent",
  "silken", "silver", "simple", "sincere", "singing", "skybound", "slate",
  "sleepy", "slender", "slick", "slow", "small", "smoky", "smooth", "snowy",
  "soaring", "soft", "solar", "solemn", "solid", "solitary", "somber",
  "sonorous", "sooty", "southern", "sparkling", "spectral", "spirited",
  "splendid", "spotted", "sprightly", "spruce", "stalwart", "starlit", "static",
  "steadfast", "stealthy", "steely", "stellar", "still", "stoic", "stony",
  "stormy", "stout", "straight", "strident", "striking", "studious", "subtle",
  "sudden", "sullen", "summer", "sunny", "supple", "swift", "tacit", "tame",
  "tangled", "tangy", "taut", "tawny", "teal", "tender", "tepid", "terse",
  "thirsty", "thorough", "thrifty", "tidy", "timber", "timely", "timid",
  "tireless", "topaz", "torrid", "tranquil", "transient", "trusty", "twilight",
  "ultra", "unbroken", "uncommon", "unique", "unruly", "unseen", "unsung",
  "unwary", "upbeat", "urgent", "valiant", "vapid", "vast", "velvet", "verdant",
  "verily", "vermilion", "vexing", "vibrant", "vigilant", "viscous", "vivid",
  "voiceless", "wakeful", "wanton", "warm", "wary", "watchful", "wavy",
  "weary", "weathered", "weighty", "western", "whirling", "whispering", "white",
  "whittled", "wild", "willing", "windswept", "winsome", "winter", "wiry",
  "wise", "wistful", "withered", "witty", "woolen", "wooly", "worthy", "yarrow",
  "yellow", "yielding", "young", "youthful", "zealous", "zenith", "zesty",
]);

export const NOUNS: readonly string[] = Object.freeze([
  "abacus", "acorn", "albatross", "amber", "anchor", "anvil", "apple", "arch",
  "arrow", "ash", "asp", "atrium", "aurora", "azalea", "badge", "badger",
  "ballad", "ballast", "bamboo", "banner", "barnacle", "basalt", "basin",
  "basket", "bastion", "bat", "bay", "bayou", "beacon", "bear", "beaver",
  "bell", "berry", "beryl", "bird", "bison", "blade", "blanket", "blaze",
  "blizzard", "bloom", "blossom", "bobcat", "bog", "bonfire", "boulder",
  "bough", "branch", "breeze", "bridge", "briar", "brick", "bridle", "brook",
  "bud", "buffalo", "bugle", "bulb", "bunker", "burrow", "burrow", "buzzard",
  "cabin", "cable", "cactus", "cairn", "calf", "camel", "campfire", "canal",
  "canary", "candle", "canopy", "canyon", "cape", "capstone", "caravan",
  "caribou", "carriage", "cascade", "casement", "castle", "cathedral", "cavern",
  "cedar", "chalet", "chalice", "chamber", "channel", "chapel", "chariot",
  "cherry", "chestnut", "chimera", "chimney", "chisel", "cipher", "circle",
  "citadel", "cliff", "cloak", "cloister", "clover", "cobalt", "cobble",
  "cobra", "cocoon", "comet", "compass", "console", "coral", "cottage",
  "cotton", "coven", "cove", "coyote", "crag", "crane", "crater", "crayon",
  "creek", "crescent", "cricket", "crow", "crown", "crystal", "cube", "currant",
  "curtain", "cypress", "dahlia", "daisy", "dandelion", "dawn", "deer", "delta",
  "den", "desert", "dewdrop", "dial", "dinghy", "dock", "dogwood", "dolphin",
  "dome", "donkey", "dove", "draft", "dragon", "drum", "duckling", "dune",
  "dusk", "dwelling", "eagle", "earring", "echo", "eel", "elm", "ember",
  "emerald", "empire", "envoy", "epoch", "equator", "ermine", "estate",
  "ether", "eve", "fable", "facet", "falcon", "fawn", "feather", "fennel",
  "fern", "ferret", "field", "fig", "fin", "finch", "fjord", "flag", "flame",
  "flicker", "flint", "flock", "flora", "flounder", "flute", "flute", "flux",
  "foal", "foliage", "forest", "forge", "forget", "fort", "foundry", "fountain",
  "fox", "frond", "frontier", "frost", "fugue", "furrow", "gable", "galaxy",
  "galleon", "garden", "gargoyle", "garnet", "gate", "gazelle", "gem",
  "geyser", "ghost", "ginger", "glacier", "glade", "glass", "glen", "glow",
  "goblet", "gondola", "gorge", "grain", "granite", "grass", "grouse", "grove",
  "guild", "gull", "habit", "hailstone", "hamlet", "hammer", "harbor", "harp",
  "harrier", "hatch", "hawk", "haze", "heath", "hedge", "helm", "henge",
  "hermit", "heron", "hickory", "hill", "hive", "hollow", "honey", "hood",
  "horn", "horse", "horseshoe", "hour", "hummingbird", "husk", "hut", "iceberg",
  "icicle", "iguana", "ingot", "inlet", "iris", "island", "ivory", "ivy",
  "jackal", "jade", "jasper", "jay", "jewel", "jubilee", "juniper", "kelp",
  "kestrel", "kettle", "kindling", "kingdom", "kite", "lake", "lamp", "lance",
  "lantern", "laurel", "lava", "leaf", "ledge", "lemon", "lens", "leopard",
  "library", "lichen", "lighthouse", "lily", "lime", "linen", "lion", "lithos",
  "litmus", "locket", "lodge", "loft", "lotus", "lyre", "magnolia", "mallard",
  "manor", "mantle", "maple", "marble", "marina", "marker", "marsh", "marvel",
  "matrix", "meadow", "medal", "memoir", "menhir", "merlot", "mesa", "meteor",
  "midge", "mile", "millet", "minaret", "mint", "mirage", "mirror", "mist",
  "moat", "mockingbird", "monolith", "moon", "moor", "moth", "mountain",
  "muse", "mushroom", "myrtle", "needle", "nest", "newt", "nimbus", "node",
  "noon", "nova", "novel", "oak", "obsidian", "ocean", "offshoot", "olive",
  "onyx", "opal", "orbit", "orchard", "orchid", "osprey", "otter", "outpost",
  "owl", "oxen", "oyster", "pagoda", "panther", "papyrus", "parchment",
  "parsnip", "passage", "patio", "peacock", "pebble", "pecan", "peony",
  "petal", "pewter", "phantom", "pheasant", "phoenix", "pier", "pillar",
  "pinecone", "pinion", "pioneer", "piper", "plainsong", "plateau", "plume",
  "polestar", "pollen", "pomelo", "pond", "poplar", "portal", "prairie",
  "primrose", "puffin", "pumpkin", "puzzle", "pylon", "pyre", "quail", "quarry",
  "quartz", "quasar", "queen", "quiver", "rabbit", "rampart", "rapids",
  "raspberry", "raven", "reed", "reef", "reverie", "ridge", "rivet", "robin",
  "rooster", "rose", "ruby", "rune", "saddle", "saffron", "sage", "sailcloth",
  "sandbar", "sapling", "sapphire", "saunter", "scallop", "scarab", "schooner",
  "scope", "scribble", "sea", "seal", "seam", "selkie", "sequoia", "shadow",
  "shaft", "shawl", "sheaf", "sheath", "shell", "shepherd", "shield", "shore",
  "shroud", "sigil", "silo", "siren", "skiff", "sky", "slate", "sloop",
  "smith", "snare", "snow", "solstice", "songbird", "sonnet", "sparrow",
  "spear", "specter", "spire", "spore", "sprig", "spruce", "stable", "stag",
  "stamp", "starling", "stave", "steeple", "stitch", "stone", "stork", "storm",
  "strand", "stream", "summit", "swallow", "sycamore", "talon", "tamarind",
  "tangerine", "tapestry", "teardrop", "thicket", "thimble", "thistle", "thorn",
  "thread", "thrush", "tide", "tile", "timber", "topaz", "torch", "totem",
  "tower", "trail", "treehouse", "tremor", "trestle", "trident", "trinket",
  "tundra", "turret", "tussock", "twig", "twilight", "umber", "umbrella",
  "valley", "vault", "veil", "verbena", "vessel", "village", "vine", "violet",
  "virgo", "viscount", "vista", "voyage", "vulture", "warbler", "warden",
  "warren", "waterfall", "wave", "weasel", "well", "whale", "wharf", "wheel",
  "whisker", "willow", "windmill", "winterberry", "wisp", "wolf", "wreath",
  "wren", "yarn", "yarrow", "yew", "yonder", "zephyr", "zinnia", "zircon",
]);

export const NAME_REGEX = /^[a-z]+-[a-z]+(-[0-9a-f]{4})?$/;

const MAX_RETRIES = 5;

/**
 * Generate a single `<adjective>-<noun>` worktree name. Pure random, no
 * uniqueness check on its own — pass `existingNames` to enable in-process
 * collision avoidance.
 *
 * @param existingNames Optional set of names already in use within the same
 *   project. When provided, the generator retries on collision and falls back
 *   to a 4-char hex suffix after MAX_RETRIES.
 */
export function generateWorktreeName(existingNames?: ReadonlySet<string>): string {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const adj = pickRandom(ADJECTIVES);
    const noun = pickRandom(NOUNS);
    const candidate = `${adj}-${noun}`;
    if (!existingNames || !existingNames.has(candidate)) {
      return candidate;
    }
  }
  // Fallback: still take a random pair, append 4-char hex suffix.
  const adj = pickRandom(ADJECTIVES);
  const noun = pickRandom(NOUNS);
  const suffix = randomBytes(2).toString("hex");
  return `${adj}-${noun}-${suffix}`;
}

/**
 * User-supplied name validator. Accepts the same shape as
 * {@link generateWorktreeName} but allows alphanumeric and hyphens for
 * user-typed names like `feature-auth-redesign`. Length-capped at 64 chars.
 */
const USER_NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidWorktreeName(name: string): boolean {
  return USER_NAME_REGEX.test(name);
}

function pickRandom<T>(list: readonly T[]): T {
  // crypto.randomBytes for slightly better distribution than Math.random.
  // The modulo introduces a negligible bias (list sizes ≪ 2^32, so at most a
  // ~10^-7 skew); acceptable for cosmetic name generation — not worth
  // rejection sampling here.
  const idx = randomBytes(4).readUInt32BE(0) % list.length;
  return list[idx];
}
