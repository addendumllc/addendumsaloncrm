-- Blog posts in the content calendar (format "article"), alongside social posts and emails.
ALTER TABLE content_posts DROP CONSTRAINT IF EXISTS content_posts_post_type_check;
ALTER TABLE content_posts ADD CONSTRAINT content_posts_post_type_check CHECK (post_type IN ('feed','carousel','reel','story','video','pin','email','promo','article'));
