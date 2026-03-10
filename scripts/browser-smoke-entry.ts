import { complete, getModel } from "@mariozechner/companion-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
