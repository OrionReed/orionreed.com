import {glob} from 'glob';
import fs from 'fs';
import fm from 'front-matter';

const posts_dir = 'public/posts/';

function loadStrings() {
  const posts = glob.sync(`${posts_dir}*.md`).map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const slug = file.replace(`${posts_dir}`, '').replace('.md', '');
    const { title, date, location } = fm(content).attributes;
    return { date, slug, title, location };
  });
  return posts.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function saveStrings(posts) {
  fs.writeFileSync('public/posts.jsonl', posts.map((post) => JSON.stringify(post)).join('\n'));
}

saveStrings(loadStrings());