# Rift Raiders — Massive Update Specification

This branch is a safe starting point for the requested gameplay overhaul. No live gameplay settings have been changed by this specification alone.

## Requested changes
- Ease boss difficulty: reduce boss health and damage without eliminating boss mechanics.
- Buff all existing skills and rebalance cooldowns.
- Remove the Meteor Shower event (do not remove the *Meteor Strike* player skill).
- Add separate leaderboards for ranked points, highest wave, and trophies. Server validation is required before accepting scores.
- Award **5 trophies per wave completed**, only once per legitimately completed wave, with secure persistence and no rewards for reconnect/replay duplicates.
- Add a trophy road with rewards and persistent milestone claiming.
- Fix explosive projectiles visually disappearing with equipped skins by separating projectile rendering from skin rendering.
- Buff shooter damage; add more shooters, pets, skins, and skills.
- Add one overpowered pet bundle and one overpowered shooter bundle costing **500,000 coins each**, with server-authoritative ownership and purchase verification.

## Implementation notes
Current game logic is embedded in `index.html`, while `server.js` handles multiplayer and ranking. Both will need coordinated changes. Avoid trusting client-submitted trophy and purchase totals. Keep tests passing with `npm test`.

## Trophy road proposed milestones
| Trophies | Reward |
| ---: | --- |
| 25 | 2,500 coins |
| 50 | Rare pet |
| 100 | 10,000 coins |
| 250 | Epic skin |
| 500 | Legendary shooter |
| 1,000 | 100,000 coins |
| 2,500 | Exclusive cosmic pet |

The values and rewards above are design proposals, not features already deployed.
