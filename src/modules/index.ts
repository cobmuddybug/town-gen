// The default modules, in the order a town is built with them. Load order is
// worked out again from each module's `requires` (core/loader.ts); this order
// only breaks ties.
import type { Module } from "../core/types";
import { core } from "./core";
import { uses } from "./uses";
import { layout } from "./layout";
import { households } from "./households";
import { materials } from "./materials";
import { names } from "./names";
import { people } from "./people";
import { character } from "./character";
import { council } from "./council";
import { sifters } from "./sifters";
import { society } from "./society";
import { routines } from "./routines";
import { visitors } from "./visitors";
import { manor } from "./manor";
import { religion } from "./religion";
import { civic } from "./civic";
import { guilds } from "./guilds";
import { lodging } from "./lodging";
import { gossip } from "./gossip";
import { crime } from "./crime";
import { weather } from "./weather";
import { region } from "./region";
import { lore } from "./lore";
import { market } from "./market";
import { lives } from "./lives";
import { politics } from "./politics";
import { hire } from "./hire";

export const defaultModules: Module[] = [core, weather, uses, layout, households, materials, names, people, character, council, society, visitors, manor, religion, civic, guilds, lodging, routines, gossip, region, lore, market, crime, lives, politics, hire, sifters];
