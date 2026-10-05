// Modified by ZCode: 2026-10 vendored de-branding, namespace/assembly/paths renamed to YazOffice.
using System.CommandLine;
using YazOffice.Core.Commands;

var rootCommand = new RootCommand("docx: OpenXML document generation and manipulation CLI");

// Scenario commands
rootCommand.Add(CreateCommand.Create());
rootCommand.Add(EditContentCommand.Create());
rootCommand.Add(ApplyTemplateCommand.Create());

// Tool commands
rootCommand.Add(ValidateCommand.Create());
rootCommand.Add(MergeRunsCommand.Create());
rootCommand.Add(FixOrderCommand.Create());
rootCommand.Add(AnalyzeCommand.Create());
rootCommand.Add(DiffCommand.Create());

return rootCommand.Parse(args).Invoke();
