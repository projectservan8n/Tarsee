export default {
  name: "boot-announce",
  events: ["boot:ready"],
  handler: async () => {
    console.log("[hooks] Tarsee is fully initialized and ready.");
  },
};
