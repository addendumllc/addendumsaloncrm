-- Transformations: "Original" photos and videos (the unedited files, uploaded when the stylist has them).
ALTER TABLE transformation_media DROP CONSTRAINT IF EXISTS transformation_media_kind_check;
ALTER TABLE transformation_media ADD CONSTRAINT transformation_media_kind_check CHECK (kind IN ('original','before','after','finished','detail','other'));
