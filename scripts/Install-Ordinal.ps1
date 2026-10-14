# platforms: windows, macOS, linux
# Ordinal text rules for the installer. In PowerShell 7 the operators -eq, -ne, -in, -contains, -like, -ceq, -cne, -cin,
# -ccontains, Sort-Object -Unique, and Select-Object -Unique compare with culture rules: a zero-width character, a soft
# hyphen, or a canonically equivalent string compares EQUAL to the plain text. So a name can pass validation and then miss
# the lookup. Every name, keyword, spec, url, path text, and lock value is compared with the helpers here, which are
# ordinal, and every value that enters from outside is refused by Assert-BoundaryText when it holds a control, a format
# character, a line or paragraph separator, or an unpaired surrogate. scripts/ordinal-guard.test.mjs fails any installer
# script that uses a culture comparison.
#
# Dot-sourced first by Install-Workspace.ps1 and by each test driver that loads an installer script.

# Whether two values are the same string, ordinally. A value that is not a string equals nothing, so a number, a null, or
# a boolean never matches a name.
function Test-OrdinalEqual {
    param($Left, $Right)

    if ($Left -isnot [string] -or $Right -isnot [string]) { return $false }
    return [string]::Equals($Left, $Right, [StringComparison]::Ordinal)
}

# Whether two field values are the same: two nulls are the same, a null and a string are not, and two strings are compared
# ordinally. A field a record may lack reads as null, so its comparison must not turn a missing value into a difference.
function Test-OrdinalSame {
    param($Left, $Right)

    if ($null -eq $Left -or $null -eq $Right) { return ($null -eq $Left -and $null -eq $Right) }
    return (Test-OrdinalEqual $Left $Right)
}

# Whether a value is one of a set of names, ordinally. A value that is not a string is in no set.
function Test-OrdinalIn {
    param($Value, [object[]] $Set)

    foreach ($item in @($Set)) {
        if (Test-OrdinalEqual $Value $item) { return $true }
    }
    return $false
}

# The distinct strings, in their first order. Two strings are distinct when they differ by one code unit.
function Get-OrdinalUnique {
    param($Values)

    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $unique = [System.Collections.Generic.List[string]]::new()
    foreach ($value in @($Values)) {
        # A null is not a name. An empty input yields no values, so a caller that passes nothing gets an empty array.
        if ($null -eq $value) { continue }
        $text = [string] $value
        if ($seen.Add($text)) { $unique.Add($text) }
    }
    return $unique.ToArray()
}

# The strings in ordinal order, as an array. Culture collation is not used, so the order is the same on every machine.
function Get-OrdinalSorted {
    param($Values)

    $sorted = [string[]] @($Values | Where-Object { $null -ne $_ })
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    return $sorted
}

# A character a value may not hold: a control, a format character (zero width, soft hyphen, byte order mark, bidi), a
# line or paragraph separator, or a surrogate that is not part of a pair. A valid surrogate pair is not one.
function Test-EscapedCharacter {
    param([char] $Character, [bool] $Paired)

    if (-not $Paired -and [char]::IsSurrogate($Character)) { return $true }
    $category = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($Character)
    return (($category -eq [Globalization.UnicodeCategory]::Control) -or ($category -eq [Globalization.UnicodeCategory]::Format) -or
        ($category -eq [Globalization.UnicodeCategory]::LineSeparator) -or ($category -eq [Globalization.UnicodeCategory]::ParagraphSeparator))
}

# The index of the first character in a text that is not allowed, or -1. Each surrogate pair is read as one character.
function Find-BoundaryIndex {
    param([string] $Text)

    for ($index = 0; $index -lt $Text.Length; $index++) {
        $character = $Text[$index]
        if ([char]::IsHighSurrogate($character) -and ($index + 1 -lt $Text.Length) -and [char]::IsLowSurrogate($Text[$index + 1])) {
            $index++
            continue
        }
        if (Test-EscapedCharacter $character $false) { return $index }
    }
    return -1
}

# The one safe-name escape. Every name or value printed in a message goes through it: each escaped character becomes \uXXXX,
# and a text longer than 260 characters is cut with an ellipsis. A valid surrogate pair is kept whole.
function ConvertTo-SafeName {
    param([AllowNull()] [string] $Text)

    if ($null -eq $Text) { return '' }
    $display = [Text.StringBuilder]::new()
    for ($index = 0; $index -lt $Text.Length; $index++) {
        $character = $Text[$index]
        if ([char]::IsHighSurrogate($character) -and ($index + 1 -lt $Text.Length) -and [char]::IsLowSurrogate($Text[$index + 1])) {
            [void] $display.Append($character).Append($Text[$index + 1])
            $index++
        } elseif (Test-EscapedCharacter $character $false) {
            [void] $display.Append(('\u{0:X4}' -f [int] $character))
        } else {
            [void] $display.Append($character)
        }
    }
    $shown = $display.ToString()
    if ($shown.Length -le 260) { return $shown }
    $cut = if ([char]::IsHighSurrogate($shown[259])) { 259 } else { 260 }
    return $shown.Substring(0, $cut) + '...'
}

# Whether a text holds only characters a name or value may hold.
function Test-BoundaryText {
    param($Text)

    if ($Text -isnot [string]) { return $true }
    return (Find-BoundaryIndex $Text) -lt 0
}

# Throws when a name or value holds a character it may not hold. The subject names where the text came from, and the text
# is printed escaped, so no raw control, format, or separator character reaches the terminal.
function Assert-BoundaryText {
    param($Text, [string] $Subject)

    if ($Text -isnot [string]) { return }
    $index = Find-BoundaryIndex $Text
    if ($index -lt 0) { return }
    $code = '\u{0:X4}' -f [int] $Text[$index]
    throw "$(ConvertTo-SafeName $Subject) '$(ConvertTo-SafeName $Text)' holds the character $code, which a name or value may not hold."
}

# Checks every name and every string in a parsed document, so no format, control, or separator character and no unpaired
# surrogate reaches a comparison or a message. Where names the place in the document for a message.
function Assert-TextBoundaryTree {
    param($Value, [string] $Where)

    if ($Value -is [string]) {
        Assert-BoundaryText $Value $Where
        return
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = @($Value.Keys)
        foreach ($key in $keys) { Assert-BoundaryText ([string] $key) "$Where key" }
        foreach ($key in $keys) { Assert-TextBoundaryTree $Value[$key] "$Where.$(ConvertTo-SafeName ([string] $key))" }
        return
    }
    if ($Value -is [pscustomobject]) {
        $properties = @($Value.PSObject.Properties)
        foreach ($property in $properties) { Assert-BoundaryText $property.Name "$Where key" }
        foreach ($property in $properties) { Assert-TextBoundaryTree $property.Value "$Where.$(ConvertTo-SafeName $property.Name)" }
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $index = 0
        foreach ($item in $Value) {
            Assert-TextBoundaryTree $item "$Where[$index]"
            $index += 1
        }
    }
}

# A JSON escape for a surrogate that is not part of a pair, such as \uD800 alone. The JSON reader turns such an escape into
# U+FFFD, so the boundary walk would not see it: the text is checked before it is parsed.
function Assert-SurrogateEscapes {
    param([AllowNull()] [string] $Text, [string] $Where)

    if ([string]::IsNullOrEmpty($Text)) { return }
    $pattern = '\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}'
    if ([regex]::IsMatch($Text, $pattern)) { throw "$Where holds an unpaired surrogate escape, which a name or value may not hold." }
}

# Whether a row's path names a layer by a whole path segment, such as plugins/pstack, or by a file name that starts with the layer
# name and a dash, such as agents/pstack-agent.md. A row of a skipped layer is not judged in a read-only run.
function Test-SkippedLabel {
    param([string] $Label, [string[]] $Layers)

    foreach ($layer in $Layers) {
        $name = [regex]::Escape($layer)
        if ([regex]::IsMatch($Label, '(?:^|[\\/"])' + $name + '(?=$|[\\/"\s\-.\]])')) { return $true }
    }
    return $false
}

# Whether two strings are the same ignoring ASCII and Unicode letter case, compared ordinally. Used for names that Windows
# treats as case-insensitive, such as folder names and drive paths. A value that is not a string equals nothing.
function Test-OrdinalEqualIgnoreCase {
    param($Left, $Right)

    if ($Left -isnot [string] -or $Right -isnot [string]) { return $false }
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

# Whether a value is the boolean true. A string such as "true" is not a boolean, so it is not true.
function Test-IsTrue {
    param($Value)

    return (($Value -is [bool]) -and $Value)
}
