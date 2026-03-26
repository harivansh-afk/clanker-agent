import { complete, getModel } from "@harivansh-afk/clanker-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
