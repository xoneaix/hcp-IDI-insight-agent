export function createPreviewWorkspace() {
  return {
    project: {
      id: "preview-study",
      name: "访客模式"
    },
    interviews: [],
    guides: [],
    reportWorkspace: {
      deckScript: null,
      instructions: "",
      supplementalFiles: [],
      slideIndex: 0,
      generatedAt: 0,
      sourceFingerprint: "",
      sourceSummary: null,
      engine: { mode: "preview" }
    }
  };
}
