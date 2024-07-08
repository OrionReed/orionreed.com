import { calcReadingTime } from '@/utils/readingTime';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export function Post() {
  const { slug } = useParams<{ slug: string }>();
  const [post, setPost] = useState<{ html: string, data: Record<string, any> } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    import(`../posts/${slug}.md`)
      .then((module) => {
        setPost({ html: module.html, data: module.data });
        setIsLoading(false);
      })
      .catch((error) => {
        console.error('Failed to load post:', error);
        setIsLoading(false);
      });
  }, [slug]);


  if (isLoading) {
    return <div className='loading'>hold on...</div>;
  }

  if (!post) {
    return <div className='loading'>post not found :&#40;</div>;
  }

  document.title = post.data.title;

  return (
    <main>
      <header>
        <a href="/" style={{ textDecoration: 'none' }}>Orion Reed</a>
      </header>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>{post.data.title}</h1>
        <span style={{ opacity: '0.5' }}>{calcReadingTime(post.html)}</span>
      </div>
      <div dangerouslySetInnerHTML={{ __html: post.html }} />
    </main>
  );
}