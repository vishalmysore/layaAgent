// send_message (simulated: the page never sends anything), ask_user and FINISH.

export const sendMessage = {
  id: "send_message",
  whenToUse: "Send a message or email to a person on the user's behalf",
  sideEffect: "sends a message to another person (simulated in this demo)",
  slots: [
    { name: "to", kinds: ["person", "proper"], instruction: "Who should the message go to?", none: "None of these is the person to send it to" },
    { name: "text", kinds: ["clause"], instruction: "What should the message say?", none: "None of these is what the message should say" },
  ],
  async run({ to, text }) {
    const out = `Message to ${to} ready: "${text}" (demo: nothing was actually sent)`;
    return { observation: out, answer: out, data: { to, text } };
  },
};

export const askUser = {
  id: "ask_user",
  whenToUse: "Ask the user to clarify when the goal leaves out who, what or where",
  slots: [],
  async run({ question }, ctx = {}) {
    const q = question || "Could you tell me more about what you mean?";
    const reply = ctx.askUser ? await ctx.askUser(q) : null;
    if (!reply) return { observation: `Asked the user: "${q}" (no reply)`, answer: q, data: { question: q, reply: null }, ok: false };
    return { observation: `The user answered: "${reply}"`, answer: `You said: "${reply}"`, data: { question: q, reply } };
  },
};

export const finish = {
  id: "FINISH",
  whenToUse: "Stop, because the information gathered already answers the goal",
  slots: [],
  async run() { return { observation: "", answer: "", data: null }; },
};
