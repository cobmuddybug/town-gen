# Changelog

Module versions go into RNG seeds: a major bump means existing seeds regenerate differently for that module.

## Unreleased

- Milestone 8: gossip 1.0.0 (secrets come out, news and chatter, spread at a block an hour through taverns, three tellings, the people it's about hear last, `knownByAt`; three sifters). Panel rows can light up buildings on the map. Content expanded across the existing tables (temperaments, looks, histories, names, debts, rivalries, disputes, decrees, living conditions, town matters, misdeeds, guild rules). Golden and town snapshots updated (pre-release).

- Milestone 7: towns. Street-plan layout for settlements over 700 people (walls, gates, wards with value classes, burgage plots, churchyards, castle, suburbs, river, quay). Urban building plan over 1,000 people. New modules religion 1.0.0, civic 1.0.0, guilds 1.0.0, lodging 1.0.0; town routines, living conditions, histories and visitors (local fair, assizes). Engine: `onWardResolved`, an edge index, `dmath.atan2`. Hamlets unchanged (the golden snapshot didn't move).

- Milestone 6: manor 1.0.0 (manorial villages: the lord, steward, regarder, bailiff and reeve; villein, cottar, free and commuted households; week-work and boon-work; the socman; runaways; bailiff visits and manor courts; four sifters). Visitors take extra sources through a `visitSources` registry. Free settlements are unchanged (the golden snapshot didn't move).

- Milestone 5: fishing, herding, mining and woodcutting bases (terrain, buildings, trades, stakes, disputes, routines); visitors 1.0.0 (tax collector, herald, players, mountebank, travelling folk, tinkers and thefts, friar, fair day); three clock-aware sifters; matters too big for the council wait for the sheriff's man. Golden snapshot updated (pre-release).

- Milestone 4: society 1.0.0 (links between households), routines 1.0.0 (six-block routines, calendar, clock), personal histories in people, five new sifters. Engine: `onSocietyResolved` phase; `edges()` sorted by id. Pre-release, so the golden snapshot was updated rather than versions bumped.

- core 1.0.0, uses 1.0.0, layout 1.0.0, households 1.0.0, materials 1.0.0, names 1.0.0, people 1.0.0, council 1.0.0, sifters-hamlet 1.0.0: first versions (milestones 1-3: skeleton and determinism, hamlet map, agricultural hamlet vertical slice).
