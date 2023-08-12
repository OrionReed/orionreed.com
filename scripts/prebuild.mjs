import {glob} from 'glob';
import fs from 'fs';
import fm from 'front-matter';


function loadPosts() {
  const posts_dir = 'public/posts_md/';
  const posts = glob.sync(`${posts_dir}*.md`).map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const slug = file.replace(`${posts_dir}`, '').replace('.md', '');
    const { title, date, location } = fm(content).attributes;
    return { date, slug, title, location };
  });
  return posts.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function loadStream() {
  const streams_dir = 'public/stream_md/';
  const posts = glob.sync(`${streams_dir}*.md`).map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const md = fm(content)
    const { date } = md.attributes;
    const text = md.body;
    return { date, text };
  });
  posts.sort((a, b) => new Date(a.date) - new Date(b.date))
  posts.forEach((post, i) => {
    post.id = i;
  })
  return posts
}

function saveJsonl(entries, file) {
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
}

saveJsonl(loadPosts(), 'public/posts.jsonl');
saveJsonl(loadStream(), 'public/stream.jsonl');