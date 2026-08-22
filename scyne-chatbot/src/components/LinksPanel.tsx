import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { prettyWikiPage, workItemId } from "@/lib/links";

export function LinksPanel({ links }: { links: { wiki: string[]; workItems: string[] } }) {
  if (!links.wiki.length && !links.workItems.length) return null;
  return (
    <Card elevation={1} className="ring-1 ring-success-500/15 bg-success-50/30">
      <CardHeader>
        <CardTitle>
          <CheckCircle2 className="size-3.5 text-success-600" />
          Published
          <Badge tone="success" size="sm" className="ml-auto normal-case tracking-normal">
            {links.wiki.length + links.workItems.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {links.wiki.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
              Wiki
            </div>
            <div className="flex flex-col gap-1.5">
              {links.wiki.map((u) => (
                <Button
                  key={u}
                  asChild
                  variant="outline"
                  size="sm"
                  className="justify-between w-full"
                >
                  <a href={u} target="_blank" rel="noreferrer">
                    <span className="truncate text-left">{prettyWikiPage(u)}</span>
                    <ArrowUpRight className="shrink-0" />
                  </a>
                </Button>
              ))}
            </div>
          </div>
        )}
        {links.workItems.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
              Work Items
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {links.workItems.map((u) => {
                const key = workItemId(u);
                return (
                  <a
                    key={u}
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
                  >
                    <Badge tone="brand" size="sm" className="w-full justify-center hover:bg-scyne-ink-100 transition-colors">
                      <span className="font-mono">{key}</span>
                    </Badge>
                  </a>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
