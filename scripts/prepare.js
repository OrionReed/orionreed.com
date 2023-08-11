import {glob} from 'glob';
import fs from 'fs';
import matter from 'gray-matter';

function loadStrings() {
  const posts = glob.sync('public/posts/*.md').map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const { title, date, location } = matter(content).data;
    const slug = file.replace('public/posts/', '').replace('.md', '');
    return { title, date, location, slug };
  });
  return posts;
}

function saveStrings(posts) {
  const jsonl = posts.map((post) => JSON.stringify(post)).join('\n');
  fs.writeFileSync('public/posts.jsonl', jsonl);
}

saveStrings(loadStrings());