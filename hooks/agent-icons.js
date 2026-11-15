// Small self-contained drawings shared by all agents assigned the same slot.
const designs = [
  ['花瓣', '✿', '#C17C91', '<path d="M12 12C5 10 5 3 9 3c2 0 3 3 3 5 0-2 1-5 3-5 4 0 4 7-3 9Zm0 0c-7 2-7 9-3 9 2 0 3-3 3-5 0 2 1 5 3 5 4 0 4-7-3-9Z"/><path d="M12 12C10 5 3 5 3 9c0 2 3 3 5 3-2 0-5 1-5 3 0 4 7 4 9-3Zm0 0c2-7 9-7 9-3 0 2-3 3-5 3 2 0 5 1 5 3 0 4-7 4-9-3Z"/>'],
  ['菱形', '◇', '#7597BD', '<path d="M12 2 21 12 12 22 3 12Z"/><path d="M12 6v12M7 12h10"/>'],
  ['风车', '✣', '#A28ABE', '<path d="M12 12 6 3c5-1 8 2 6 9ZM12 12l9-6c1 5-2 8-9 6ZM12 12l6 9c-5 1-8-2-6-9ZM12 12l-9 6c-1-5 2-8 9-6Z"/>'],
  ['星芒', '✧', '#BE9671', '<path d="M12 2c1 6 3 8 10 10-7 2-9 4-10 10-1-6-3-8-10-10 7-2 9-4 10-10Z"/>'],
  ['沙漏', '⌛', '#8DA78D', '<path d="M5 3h14M5 21h14M6 3c0 5 2 7 6 9-4 2-6 4-6 9m12-18c0 5-2 7-6 9 4 2 6 4 6 9"/>'],
  ['井字', '♯', '#C18F7C', '<path d="M9 3 7 21M17 3l-2 18M3 9h18M3 16h18"/>'],
  ['四叶', '❀', '#86A6A3', '<path d="M12 12C4 12 3 4 7 4c3 0 5 4 5 8Zm0 0c0-8 8-9 8-5 0 3-4 5-8 5Zm0 0c8 0 9 8 5 8-3 0-5-4-5-8Zm0 0c0 8-8 9-8 5 0-3 4-5 8-5Z"/>'],
  ['六角', '⬡', '#A696C0', '<path d="m7 3 10 0 5 9-5 9H7l-5-9Z"/><path d="m7 8 5-3 5 3v8l-5 3-5-3Z"/>'],
  ['雪花', '❄', '#79A4BC', '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3"/>'],
  ['太阳', '☼', '#C7A268', '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>'],
  ['八芒', '✳', '#A88D9D', '<path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19"/><circle cx="12" cy="12" r="3"/>'],
  ['交织', '❖', '#83A69A', '<path d="M12 2 22 12 12 22 2 12ZM12 6l6 6-6 6-6-6Z"/>'],
  ['三角', '△', '#B79579', '<path d="M12 3 22 20H2Z"/><path d="M12 8v8m-4 2 4-2 4 2"/>'],
  ['花环', '✺', '#C3888E', '<circle cx="12" cy="12" r="3"/><path d="M12 9C8 5 10 2 12 2s4 3 0 7Zm3 3c4-4 7-2 7 0s-3 4-7 0Zm-3 3c4 4 2 7 0 7s-4-3 0-7Zm-3-3c-4 4-7 2-7 0s3-4 7 0Z"/>'],
  ['方格', '▧', '#91A1BA', '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M3 15h18M9 3v18m6-18v18"/>'],
  ['旋星', '✦', '#B19C77', '<path d="M12 2 14 8 20 5l-3 6 5 1-5 2 3 6-6-3-2 5-2-5-6 3 3-6-5-2 5-1-3-6 6 3Z"/>'],
];

export const agentVisuals = designs.map(([alt, glyph, color, drawing]) => Object.freeze({
  alt: `代理图标：${alt}`,
  glyph,
  source: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${drawing}</svg>`,
}));
