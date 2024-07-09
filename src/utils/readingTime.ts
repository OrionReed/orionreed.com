export const calcReadingTime = (text: string): string => {
  if (!text) return "∞ min read";

  const wordsPerMinute = 300;
  const wordCount = text.split(/\s+/).length;
  const minutes = Math.ceil(wordCount / wordsPerMinute);

  return `${minutes} min read`;
};