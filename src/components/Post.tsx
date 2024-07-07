import React from 'react';
import { useParams } from 'react-router-dom';

export function Post() {
  const { slug } = useParams<{ slug: string }>();
  const [post, setPost] = React.useState<{ title: string, html: string } | null>(null);

  React.useEffect(() => {
    import(`../posts/${slug}.md`)
      .then((module) => {
        setPost(module.default);
      })
      .catch((error) => {
        console.error('Failed to load post:', error);
        setPost(null);
      });
  }, [slug]);

  if (!post) {
    return <div>Loading...</div>;
  }

  return (
    <main>
      <header>
        <a href="/" style={{ textDecoration: 'none' }}>Orion Reed</a>
      </header>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.html }} />
    </main>
  );
}