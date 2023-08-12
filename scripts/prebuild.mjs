import {glob} from 'glob';
import fs from 'fs';
import fm from 'front-matter';

function loadStrings() {
  const posts = glob.sync('public/posts/*.md').map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const { title, date, location } = fm(content).attributes;
    const slug = file.replace('public/posts/', '').replace('.md', '');
    return { date, slug, title, location };
  });
  posts.sort((a, b) => new Date(a.date) - new Date(b.date))
  return posts;
}

function saveStrings(posts) {
  console.log(posts);
  const jsonl = posts.map((post) => JSON.stringify(post)).join('\n');
  fs.writeFileSync('public/posts.jsonl', jsonl);
}

saveStrings(loadStrings());