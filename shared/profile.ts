/**
 * THE TWO SHAPES OF A PROFILE THAT CROSS THE WIRE.
 *
 * They live here, and not once per side, because `tests/unit/no-type-mirrors.ts`
 * forbids the alternative and the history behind that gate is the reason: a
 * hand-copied type carries a comment saying "keep in sync" and then does not.
 * `Topic.mcpPolicy` never reached the client, the client's `BoardSettings` did
 * not know about `dispatchRetryCap` and a PATCH built from it would have
 * cleared the field. Both sides re-export from here, so there is one
 * declaration and no copy to forget.
 *
 * They are only these two. The rest of the profile payload is deliberately NOT
 * here: the server's row shapes are its own business, and the client's render
 * shapes are the client's, so mirroring them would import a coupling neither
 * side asked for. What has to agree is what travels, and what travels is a set
 * of switches and a pair of numbers.
 */

/**
 * The five switches of the privacy panel.
 *
 * EVERY ONE OF THEM IS ENFORCED ON THE SERVER, by removing the value from the
 * response. This shape is what a person SETS, never a flag the client is
 * trusted to obey: a hidden statistic arrives as `null`, a hidden email as
 * `null`, a hidden person as a 404. A client that ignored the whole object
 * would have nothing extra to draw, which is the test of whether the switches
 * are real.
 */
export interface ProfilePrivacy {
  /** The profile is reachable at all. False hides the person everywhere. */
  showProfile: boolean;
  /** Prompts, tokens and cost. */
  showStats: boolean;
  /** The email address. Closed by default: it is the one field whose
   *  publication cannot be taken back. */
  showEmail: boolean;
  /** The two counters and the two lists. */
  showFollowers: boolean;
  /** Last seen, and therefore whether the person reads as online. */
  showPresence: boolean;
}

/**
 * The two counters of the follow graph.
 *
 * Two numbers and not one, because the edge is ASYMMETRIC: how many people
 * read you and how many you read are different facts, and a product that
 * showed a single "friends" figure would be describing a relation this graph
 * does not have.
 */
export interface ConteggiFollow {
  /** How many people follow this person. */
  followers: number;
  /** How many people this person follows. */
  following: number;
}
