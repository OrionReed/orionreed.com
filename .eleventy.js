export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy('src/assets/css')
  eleventyConfig.addPassthroughCopy("src/assets/favicon.ico");
  eleventyConfig.addPassthroughCopy("src/objects");
  eleventyConfig.setServerPassthroughCopyBehavior("passthrough");

  return {
    dir: {
      input: "src",
      output: "dist"
    }
  }
};
