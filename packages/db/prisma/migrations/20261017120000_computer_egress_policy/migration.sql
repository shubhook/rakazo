-- AlterTable
ALTER TABLE "computers" ADD COLUMN     "egressAllowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "egressAllowedTcp" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "egressMode" TEXT NOT NULL DEFAULT 'open';
