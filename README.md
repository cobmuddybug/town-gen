# Town Generator

A generator for mundane medieval settlements, for D&D and other tabletop games. It's human-only, has no working magic, and leans on the grinding plausibility of a real hamlet: debts, boundary stones, short measure at the mill.

Click a building to find out who lives there. Click a person for their family, their temper, and who they're quarrelling with. Nothing is generated until you look at it, and the same seed always gives the same town.

```sh
npm install
npm run dev      # then open the printed URL
npm test
```

- **Seeds are towns.** A save file holds the seed, module versions and your edits, never the whole town.
- **Edit or reroll any field.** Downstream details follow your edit. Names and unrelated details don't move.
- **Pin** the people your players know, so generator upgrades leave them alone.
- **Hamlets to cities.** Up to about 700 people you get a hamlet with its fields; beyond that a street plan: a village with its Ends, or a walled town with wards, guilds, the watch, the courts and a dozen parish churches, up to 30,000 people.
- **Gossip.** Secrets come out and spread house by house, a block an hour, faster through the taverns, growing in the telling. Move the clock and watch it travel.
- **Ways in.** Ask *who knows* about any debt, affair, feud or rumour, and see where each of them is now and later today. Colour the map by wealth, class, parish, ward value or guild, or draw the threads from one person to everyone they're tied to. Search everyone and everything, browse ready-made lists, read the almanac of what's coming, and follow one person through their day.
- **Hooks** are found by pattern-matching the social graph, not rolled from a table.

See `docs/DESIGN.md` for the design and roadmap.

## Licence

MIT. See `LICENSE`. Generation parameters are drawn from Gary Gygax's *Living Fantasy* (Troll Lord Games, 2003) as reference: all tables are written in our own words and cite page numbers.
