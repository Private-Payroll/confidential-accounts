/**
 * THE ONE PLACE IN THIS REPOSITORY THAT SPELLS THE INDEXER'S VIEWING-KEY FIELD.
 *
 * WHAT THE FIELD IS. This wallet's indexer offers a convenience: hand it a
 * viewing key and it will filter the chain for you and send back only the
 * transactions that concern your wallet. That is a shortcut this product must
 * never take. A viewing key lets its holder decrypt every payment the wallet
 * ever makes or receives, so sending one to a server makes that server's
 * operator a reader of the user's entire financial history. This wallet takes
 * the whole-chain event stream instead and decrypts locally, which is slower
 * and which is the point.
 *
 * WHY THE SPELLING LIVES HERE AND NOWHERE ELSE. The rule above is enforced by
 * scanning this repository's own source for the field name: any file that names
 * it in code, rather than in a comment, is the file where the forbidden call
 * would be written. That scan has to compare against the field name, and the
 * probe that watches real network traffic has to look for the same string. Two
 * copies of a tripwire's trigger is one copy that can be edited without the
 * other noticing, so both ends read it from here, and the scan skips exactly
 * this path.
 *
 * THE SKIP IS BY PATH, NOT BY NAME, AND NOT BY A LIST. An earlier version of
 * the scan kept a list of files allowed to name the field, and the file where
 * the offending call would actually have been written was on it, because its
 * own comment documented the rule. Writing the rule down had punched the hole
 * in it. So there is no list: comments are stripped before scanning,
 * documentation stays legal in every file, and one exact path — this one — is
 * outside the scan because it is the scan's own trigger. Anything else that
 * names the field imports it from here, and a second file that spells it out
 * turns the scan red.
 *
 * NOTHING HERE TOUCHES THE NETWORK, A KEY OR THE FILESYSTEM. It is a string and
 * a predicate, so a test can hold it and the network probe can import it.
 */

/**
 * The indexer request field that would hand over the ability to read every
 * payment this wallet makes. Nothing in this repository may send it.
 */
export const VIEWING_KEY_FIELD = 'viewingKey';

/**
 * Does this text name the field? Used by the source scan over this
 * repository's own two source trees, and by the network probe over every
 * request and websocket frame a real browser sends.
 *
 * Anything that is not a string is not a mention: the probe hands over request
 * bodies that are frequently absent, and treating a missing body as a hit
 * would fail every run for the wrong reason.
 */
export function mentionsViewingKey(text) {
  return typeof text === 'string' && text.includes(VIEWING_KEY_FIELD);
}
