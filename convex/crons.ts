import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("drop devices that went silent", { seconds: 15 }, internal.presence.sweep, {});

export default crons;
