/**
 * Named moves — 5 classes × 3 stances.
 *
 * The stances stay a three-way triangle (Strike ▶ Cast ▶ Guard ▶ Strike); only
 * the names and icons change per class. Giving each class its own mechanics
 * would mean balancing fifteen moves instead of three, which is far more than
 * a two-minute battle at the end of a lesson can justify.
 */

export const SKILLS = {
  warrior: {
    attack: { name: 'Berserker Rush', icon: '🪓', flavor: 'Charge in swinging' },
    defend: { name: 'Iron Wall', icon: '🛡️', flavor: 'Plant your feet and take it' },
    magic: { name: 'Blood Roar', icon: '🔥', flavor: 'A scream that shakes the arena' },
  },
  knight: {
    attack: { name: 'Shield Bash', icon: '⚒️', flavor: 'The shield is the weapon' },
    defend: { name: 'Bulwark', icon: '🏰', flavor: 'Nothing gets through' },
    magic: { name: 'Holy Ward', icon: '🕊️', flavor: 'Light that answers back' },
  },
  thief: {
    attack: { name: 'Backstab', icon: '🗡️', flavor: 'Gone before they turn' },
    defend: { name: 'Smoke Veil', icon: '💨', flavor: 'Hit what you cannot see' },
    magic: { name: 'Poison Mist', icon: '☠️', flavor: 'Patient, and unfair' },
  },
  mage: {
    attack: { name: 'Arcane Bolt', icon: '🔮', flavor: 'Straight to the chest' },
    defend: { name: 'Mana Shield', icon: '💠', flavor: 'Turn magic into armour' },
    magic: { name: 'Meteor Call', icon: '☄️', flavor: 'Pull the sky down' },
  },
  healer: {
    attack: { name: 'Judgement', icon: '⚖️', flavor: 'Mercy has a limit' },
    defend: { name: 'Sanctuary', icon: '🔆', flavor: 'Wounds close as fast as they open' },
    magic: { name: 'Rebuke', icon: '✨', flavor: 'The kind word runs out' },
  },
};

/** Falls back to the healer's line for a class id the wall does not know —
 *  a card built before a class was renamed should still animate. */
export function skillOf(classId, stance) {
  return SKILLS[classId]?.[stance] ?? SKILLS.healer[stance] ?? SKILLS.healer.attack;
}
