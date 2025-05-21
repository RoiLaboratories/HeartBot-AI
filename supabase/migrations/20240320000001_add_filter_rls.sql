-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can read their own filters" ON "Filter";
DROP POLICY IF EXISTS "Users can insert their own filters" ON "Filter";
DROP POLICY IF EXISTS "Users can update their own filters" ON "Filter";
DROP POLICY IF EXISTS "Users can delete their own filters" ON "Filter";

-- Enable RLS on Filter table
ALTER TABLE "Filter" ENABLE ROW LEVEL SECURITY;

-- Create policy to allow users to read their own filters
CREATE POLICY "Users can read their own filters"
ON "Filter"
FOR SELECT
USING (auth.uid()::text = user_id);

-- Create policy to allow users to insert their own filters
CREATE POLICY "Users can insert their own filters"
ON "Filter"
FOR INSERT
WITH CHECK (auth.uid()::text = user_id);

-- Create policy to allow users to update their own filters
CREATE POLICY "Users can update their own filters"
ON "Filter"
FOR UPDATE
USING (auth.uid()::text = user_id)
WITH CHECK (auth.uid()::text = user_id);

-- Create policy to allow users to delete their own filters
CREATE POLICY "Users can delete their own filters"
ON "Filter"
FOR DELETE
USING (auth.uid()::text = user_id); 